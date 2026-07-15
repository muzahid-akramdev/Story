import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const DOWNLOADER_URL = 'https://snapinsta.app/action.php';

function extractMediaUrl(html) {
  const $ = cheerio.load(html);
  const selectors = [
    'a.download-url', 'a[download]', '.download-link a',
    'video source', 'img.story-image', 'img[src*="fbcdn"]'
  ];
  for (const sel of selectors) {
    const el = $(sel);
    if (el.length) {
      const href = el.attr('href') || el.attr('src');
      if (href && (href.startsWith('http') || href.startsWith('//'))) {
        return href.startsWith('//') ? 'https:' + href : href;
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No story link provided' });
  try {
    const formData = new URLSearchParams();
    formData.append('url', storyLink);
    const resp = await axios.post(DOWNLOADER_URL, formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000
    });
    const mediaUrl = extractMediaUrl(resp.data);
    if (!mediaUrl) return res.status(400).json({ error: 'Could not extract media URL.' });

    const mediaResp = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const contentType = mediaResp.headers['content-type'] || 'image/jpeg';
    const isVideo = contentType.startsWith('video');
    const ext = isVideo ? 'mp4' : 'jpg';

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const fileName = `stories/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('story-media')
      .upload(fileName, mediaResp.data, { contentType, upsert: true });
    if (uploadError) throw uploadError;
    const { data: publicUrlData } = supabase.storage.from('story-media').getPublicUrl(fileName);

    await supabase.from('stories').insert({
      original_link: storyLink,
      media_url: publicUrlData.publicUrl,
      media_type: isVideo ? 'video' : 'image'
    });
    return res.status(200).json({ success: true, mediaUrl: publicUrlData.publicUrl, type: isVideo ? 'video' : 'image' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
