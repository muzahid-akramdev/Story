import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const BRAVEDOWN_PAGE = 'https://bravedown.com/facebook-story-downloader';
const BRAVEDOWN_API = 'https://bravedown.com/livewire/update';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No story link provided' });

  try {
    // Step 1: Visit BraveDown and get fresh cookies + CSRF token
    const pageResp = await axios.get(BRAVEDOWN_PAGE, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      timeout: 15000,
      withCredentials: true
    });

    // Extract all cookies from Set-Cookie headers
    const setCookieHeaders = pageResp.headers['set-cookie'] || [];
    let sessionCookie = '';
    let xsrfToken = '';

    setCookieHeaders.forEach(cookie => {
      const parts = cookie.split(';')[0];
      if (parts.includes('bravedown_session') || parts.includes('laravel_session')) {
        sessionCookie += (sessionCookie ? '; ' : '') + parts;
      }
      if (parts.includes('XSRF-TOKEN')) {
        xsrfToken = decodeURIComponent(parts.split('=')[1]);
      }
    });

    // Step 2: Find the Livewire component ID in the page
    const wireIdMatch = pageResp.data.match(/wire:id="([^"]+)"/i) || 
                        pageResp.data.match(/wire:id=([^\s>]+)/i);
    const wireId = wireIdMatch ? wireIdMatch[1].replace(/"/g, '') : '';

    // Step 3: If no XSRF token in cookie, try to find it in the page HTML
    if (!xsrfToken) {
      const tokenMatch = pageResp.data.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i);
      if (tokenMatch) xsrfToken = tokenMatch[1];
    }

    // Step 4: Also try to get token from Livewire's own meta
    if (!xsrfToken) {
      const lwToken = pageResp.data.match(/csrf_token['"]\s*:\s*['"]([^'"]+)['"]/i);
      if (lwToken) xsrfToken = lwToken[1];
    }

    if (!xsrfToken || !wireId) {
      return res.status(500).json({ 
        error: 'Could not initialize session with BraveDown',
        debug: { token: !!xsrfToken, wireId: !!wireId }
      });
    }

    // Step 5: Build the exact payload
    const snapshot = {
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
    };

    const payload = {
      _token: xsrfToken,
      components: [{
        snapshot: JSON.stringify(snapshot),
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

    // Step 6: Call BraveDown's API
    const bravedownResp = await axios.post(BRAVEDOWN_API, payload, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Livewire': 'true',
        'X-CSRF-TOKEN': xsrfToken,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Referer': BRAVEDOWN_PAGE + '/',
        'Origin': 'https://bravedown.com',
        'Cookie': sessionCookie
      },
      timeout: 25000
    });

    // Step 7: Extract download URL
    const respData = bravedownResp.data;
    let downloadUrl = null;

    if (respData.components && respData.components[0]) {
      try {
        const snapData = JSON.parse(respData.components[0].snapshot);
        if (snapData.data && snapData.data.data && snapData.data.data[0]) {
          const links = snapData.data.data[0].links;
          if (links && links[0] && links[0][0] && links[0][0][0]) {
            downloadUrl = links[0][0][0][0].url;
          }
        }
      } catch (e) {
        // Regex fallback
        const match = JSON.stringify(respData).match(/https?:\\\/\\\/acdn\.bravedown\.com\\\/download\?token=[^"\\\s]+/);
        if (match) downloadUrl = match[0].replace(/\\\//g, '/');
      }
    }

    if (!downloadUrl) {
      return res.status(400).json({ error: 'BraveDown did not return a download URL. Story may be private or expired.' });
    }

    // Step 8: Download from BraveDown's CDN
    const mediaResp = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const contentType = mediaResp.headers['content-type'] || 'image/jpeg';
    const isVideo = contentType.startsWith('video');
    const ext = isVideo ? 'mp4' : 'jpg';

    // Step 9: Upload to Supabase
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
