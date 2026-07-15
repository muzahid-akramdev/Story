import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No story link provided' });

  try {
    // Fetch the story page (anonymous)
    const pageResp = await axios.get(storyLink, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 15000
    });

    const html = pageResp.data;
    let mediaUrl = null;
    let isVideo = false;

    // Method 1: Look for story video in Facebook's video tag
    const videoMatch = html.match(/<video[^>]*>[\s\S]*?<source\s+src="([^"]+\.mp4[^"]*)"/i);
    if (videoMatch) {
      mediaUrl = videoMatch[1].replace(/&amp;/g, '&');
      isVideo = true;
    }

    // Method 2: Look for story image in Facebook's story image tag
    if (!mediaUrl) {
      const imgMatch = html.match(/<img[^>]*class="[^"]*story[^"]*"[^>]*src="([^"]+)"/i)
        || html.match(/<img[^>]*src="([^"]*story[^"]*\.(jpg|jpeg|png|webp)[^"]*)"/i)
        || html.match(/<img[^>]*src="([^"]*stories[^"]*\.(jpg|jpeg|png|webp)[^"]*)"/i);
      if (imgMatch) {
        mediaUrl = imgMatch[1].replace(/&amp;/g, '&');
      }
    }

    // Method 3: Look for Facebook's story media in JSON data
    if (!mediaUrl) {
      const jsonMatch = html.match(/"story_bucket_owner"[^}]+"story_media_url":"([^"]+)"/i)
        || html.match(/"media_url":"([^"]+)"/i)
        || html.match(/"url":"(https:\\\/\\\/[^"]*fbcdn[^"]*\.(mp4|jpg|jpeg|png|webp)[^"]*)"/i);
      if (jsonMatch) {
        mediaUrl = jsonMatch[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
        if (mediaUrl.endsWith('.mp4')) isVideo = true;
      }
    }

    // Method 4: Look for video download link
    if (!mediaUrl) {
      const downloadMatch = html.match(/"download_url":"([^"]+)"/i)
        || html.match(/<a[^>]*href="([^"]*fbcdn[^"]*\.(mp4)[^"]*)"[^>]*download/i);
      if (downloadMatch) {
        mediaUrl = downloadMatch[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
        isVideo = true;
      }
    }

    // Method 5: Facebook's blob/attachment URLs
    if (!mediaUrl) {
      const blobMatch = html.match(/"playable_url":"([^"]+)"/i)
        || html.match(/"playable_url_quality_hd":"([^"]+)"/i)
        || html.match(/"browser_native_video_url":"([^"]+)"/i);
      if (blobMatch) {
        mediaUrl = blobMatch[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
        isVideo = true;
      }
    }

    // Method 6: Find any video in the page (last resort)
    if (!mediaUrl) {
      const anyVideo = html.match(/<source\s+src="([^"]+\.mp4[^"]*)"/i)
        || html.match(/<video[^>]+src="([^"]+\.mp4[^"]*)"/i);
      if (anyVideo) {
        mediaUrl = anyVideo[1].replace(/&amp;/g, '&');
        isVideo = true;
      }
    }

    // Method 7: Find large images only (stories are usually > 200px)
    if (!mediaUrl) {
      const allImages = html.match(/<img[^>]+src="([^"]+)"/gi);
      if (allImages) {
        for (const imgTag of allImages) {
          const srcMatch = imgTag.match(/src="([^"]+)"/);
          if (srcMatch) {
            const src = srcMatch[1].replace(/&amp;/g, '&');
            // Filter out small icons, profile pics, etc.
            if (src.includes('fbcdn') && 
                !src.includes('profile') && 
                !src.includes('icon') && 
                !src.includes('emoji') &&
                !src.includes('thumb') &&
                !src.includes('avatar') &&
                (src.includes('story') || src.includes('stories') || src.match(/\/\d+x\d+\//))) {
              mediaUrl = src;
              break;
            }
          }
        }
      }
    }

    if (!mediaUrl) {
      return res.status(400).json({ 
        error: 'Could not find story media. The story may be private or expired. Try a public story.' 
      });
    }

    // Fix URL if it starts with //
    if (mediaUrl.startsWith('//')) {
      mediaUrl = 'https:' + mediaUrl;
    }

    console.log('Found media URL:', mediaUrl);

    // Download the actual media
    const mediaResp = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://www.facebook.com/'
      }
    });

    const contentType = mediaResp.headers['content-type'] || (isVideo ? 'video/mp4' : 'image/jpeg');
    const ext = isVideo ? 'mp4' : (contentType.includes('png') ? 'png' : 'jpg');

    // Upload to Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    
    const fileName = `stories/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    
    const { error: uploadError } = await supabase.storage
      .from('story-media')
      .upload(fileName, mediaResp.data, { contentType, upsert: true });
    
    if (uploadError) {
      return res.status(500).json({ error: 'Upload failed', details: uploadError.message });
    }

    const { data: publicUrlData } = supabase.storage.from('story-media').getPublicUrl(fileName);
    
    await supabase.from('stories').insert({
      original_link: storyLink,
      media_url: publicUrlData.publicUrl,
      media_type: isVideo ? 'video' : 'image'
    });

    return res.status(200).json({
      success: true,
      mediaUrl: publicUrlData.publicUrl,
      type: isVideo ? 'video' : 'image'
    });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: 'Download failed', message: err.message });
  }
}
