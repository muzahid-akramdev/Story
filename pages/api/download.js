import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No story link provided' });

  try {
    // Extract profile ID and story ID from the URL
    // URL format: /stories/{profile_id}/{story_id}/
    const urlParts = storyLink.match(/\/stories\/(\d+)\/([^/?]+)/);
    
    if (!urlParts) {
      return res.status(400).json({ error: 'Invalid story URL format' });
    }

    const profileId = urlParts[1];
    const storyId = decodeURIComponent(urlParts[2]);

    // Method 1: Try Facebook's graph API for public stories
    // This works for PUBLIC stories without any authentication
    let mediaUrl = null;

    try {
      const graphResp = await axios.get(
        `https://graph.facebook.com/v18.0/${profileId}_${storyId}`,
        {
          params: {
            fields: 'source,media_type',
            access_token: '6628568379|c1e620fa708a1d5696fb991c1bde5662' // Facebook's own public app token
          },
          timeout: 10000
        }
      );
      if (graphResp.data.source) {
        mediaUrl = graphResp.data.source;
      }
    } catch (err) {
      // Graph API failed, try fallback method
    }

    // Method 2: Direct CDN URL construction (what BraveDown likely does)
    if (!mediaUrl) {
      // Facebook stores public story media on their CDN
      // The CDN URL can be constructed from the story ID
      const cdnUrl = `https://video.fbcdn.net/v/${storyId}`;
      
      try {
        const cdnResp = await axios.get(cdnUrl, {
          maxRedirects: 5,
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          }
        });
        if (cdnResp.request.res.responseUrl) {
          mediaUrl = cdnResp.request.res.responseUrl;
        }
      } catch (err) {
        // CDN method failed
      }
    }

    // Method 3: Try the anonymous story viewer URL
    if (!mediaUrl) {
      const viewUrl = `https://www.facebook.com/stories/${profileId}/${storyId}`;
      
      const viewResp = await axios.get(viewUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 15000
      });

      // Extract media URL from the page source
      const htmlStr = viewResp.data;
      const fbcdnMatch = htmlStr.match(/(https:\/\/[^"<>]+\.fbcdn\.net\/[^"<>]+\.(?:mp4|jpg|jpeg|png|webp)[^"<>]*)/i);
      if (fbcdnMatch) {
        mediaUrl = fbcdnMatch[1];
      }
    }

    if (!mediaUrl) {
      return res.status(400).json({ error: 'Could not find media. The story may be private or expired.' });
    }

    // Download the media file
    const mediaResp = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    const contentType = mediaResp.headers['content-type'] || 'image/jpeg';
    const isVideo = contentType.startsWith('video');
    const ext = isVideo ? 'mp4' : 'jpg';

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
      return res.status(500).json({ error: 'Supabase upload failed', details: uploadError.message });
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
