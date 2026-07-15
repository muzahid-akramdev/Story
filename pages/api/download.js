import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// BraveDown's real API
const BRAVEDOWN_API = 'https://bravedown.com/livewire/update';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No story link provided' });

  try {
    // First, get a fresh CSRF token by visiting the page
    const pageResp = await axios.get('https://bravedown.com/facebook-story-downloader', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36' },
      timeout: 10000
    });

    // Extract CSRF token from cookies
    const cookies = pageResp.headers['set-cookie'] || [];
    const xsrfToken = cookies.find(c => c.includes('XSRF-TOKEN'))?.split(';')[0]?.split('=')[1] || '';
    const sessionCookie = cookies.find(c => c.includes('laravel_session') || c.includes('bravedown_session'))?.split(';')[0] || '';

    // Parse CSRF token from page if not in cookies
    let token = xsrfToken || '';
    if (!token) {
      const tokenMatch = pageResp.data.match(/<meta name="csrf-token" content="([^"]+)"/);
      if (tokenMatch) token = tokenMatch[1];
    }

    // Get the Livewire component ID from the page
    const wireIdMatch = pageResp.data.match(/wire:id="([^"]+)"/);
    const wireId = wireIdMatch ? wireIdMatch[1] : 'wex64yrPcL5n6jal6VSt';

    // Build the request payload (exactly like BraveDown's frontend)
    const payload = {
      _token: token,
      components: [{
        snapshot: JSON.stringify({
          data: {
            zlinkz: null,
            render_mode: false,
            stream_vid: false,
            stream_thumb: true,
            data: null,
            status: null,
            message: null
          },
          memo: {
            id: wireId,
            name: 'public.tool.downloader-public',
            path: 'facebook-story-downloader',
            method: 'GET',
            release: 'a-a-a',
            children: [],
            scripts: ['25050802-0'],
            assets: [],
            errors: [],
            locale: 'en'
          },
          checksum: '52e57ef209d2075abcb8a18e9a984fac4757978ea97010a346dcdaf5818e95d5'
        }),
        updates: {
          zlinkz: storyLink
        },
        calls: [{
          path: '',
          method: 'onDownload',
          params: []
        }]
      }]
    };

    // Call BraveDown's Livewire API
    const bravedownResp = await axios.post(BRAVEDOWN_API, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Livewire': 'true',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Referer': 'https://bravedown.com/facebook-story-downloader',
        'Cookie': sessionCookie
      },
      timeout: 20000
    });

    // Parse the response to get the download URL
    const respData = bravedownResp.data;
    let downloadUrl = null;

    // Extract the download URL from the nested JSON response
    try {
      const snapshot = JSON.parse(respData.components[0].snapshot);
      if (snapshot.data && snapshot.data.data && snapshot.data.data[0]) {
        const storyData = snapshot.data.data[0];
        if (storyData.links && storyData.links[0] && storyData.links[0][0]) {
          downloadUrl = storyData.links[0][0][0][0].url;
        }
      }
    } catch (e) {
      // Try regex fallback
      const urlMatch = JSON.stringify(respData).match(/https:\\\/\\\/acdn\.bravedown\.com\\\/download\?token=[^"\\]+/);
      if (urlMatch) {
        downloadUrl = urlMatch[0].replace(/\\\//g, '/');
      }
    }

    if (!downloadUrl) {
      return res.status(400).json({ error: 'Could not extract download URL from BraveDown' });
    }

    // Download the media file from BraveDown's CDN
    const mediaResp = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const contentType = mediaResp.headers['content-type'] || 'image/jpeg';
    const isVideo = contentType.startsWith('video');
    const ext = isVideo ? 'mp4' : 'jpg';

    // Upload to Supabase
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
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
    return res.status(500).json({ 
      error: 'Download failed', 
      message: err.response?.status || err.message 
    });
  }
}
