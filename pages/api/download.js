import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const BRAVEDOWN_LIVEWIRE = 'https://bravedown.com/livewire/update';
const BRAVEDOWN_PAGE = 'https://bravedown.com/facebook-story-downloader';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No story link provided' });

  try {
    // Step 1: Visit BraveDown and get cookies
    const pageResp = await axios.get(BRAVEDOWN_PAGE, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 15000,
      withCredentials: true
    });

    // Extract all cookies from response
    const setCookies = pageResp.headers['set-cookie'] || [];
    const cookieString = setCookies.map(c => c.split(';')[0]).join('; ');

    // Extract XSRF-TOKEN from cookies
    let xsrfCookie = '';
    setCookies.forEach(c => {
      const match = c.match(/XSRF-TOKEN=([^;]+)/);
      if (match) xsrfCookie = decodeURIComponent(match[1]);
    });

    // Extract wire:id from HTML
    const wireIdMatch = pageResp.data.match(/wire:id="([^"]+)"/i);
    const wireId = wireIdMatch ? wireIdMatch[1] : '';

    // Extract checksum from HTML
    const checksumMatch = pageResp.data.match(/checksum['"]?\s*:\s*['"]([a-f0-9]{64})['"]/i);
    const checksum = checksumMatch ? checksumMatch[1] : '';

    // Extract _token (CSRF) from the page's Livewire data
    const tokenMatch = pageResp.data.match(/csrf_token['"]?\s*:\s*['"]([^'"]+)['"]/i)
      || pageResp.data.match(/"token":"([^"]+)"/i);
    const csrfToken = tokenMatch ? tokenMatch[1] : '';

    if (!wireId || !csrfToken || !cookieString) {
      return res.status(500).json({ 
        error: 'Failed to initialize BraveDown session',
        debug: { wireId: !!wireId, token: !!csrfToken, cookies: !!cookieString }
      });
    }

    // Step 2: Build snapshot with extracted values
    const snapshot = JSON.stringify({
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
      checksum: checksum
    });

    const payload = {
      _token: csrfToken,
      components: [{
        snapshot: snapshot,
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

    // Step 3: Send request WITH COOKIES
    const downloadResp = await axios.post(BRAVEDOWN_LIVEWIRE, payload, {
      headers: {
        'Content-type': 'application/json;charset=UTF-8',
        'X-Livewire': '',
        'X-XSRF-TOKEN': xsrfCookie,
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Referer': BRAVEDOWN_PAGE,
        'Origin': 'https://bravedown.com'
      },
      timeout: 25000
    });

    // Step 4: Parse response
    const respData = downloadResp.data;
    let downloadUrl = null;

    if (respData.components && respData.components[0] && respData.components[0].snapshot) {
      const snapData = JSON.parse(respData.components[0].snapshot);
      if (snapData.data && snapData.data.data && Array.isArray(snapData.data.data) && snapData.data.data[0]) {
        const links = snapData.data.data[0].links;
        if (links && links[0] && links[0][0] && links[0][0][0]) {
          downloadUrl = links[0][0][0][0].url;
        }
      }
    }

    if (!downloadUrl) {
      return res.status(400).json({ 
        error: 'BraveDown did not return a download URL. Story may be private or expired.'
      });
    }

    // Step 5: Download media from BraveDown's CDN
    const mediaResp = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const contentType = mediaResp.headers['content-type'] || 'image/jpeg';
    const isVideo = contentType.startsWith('video');
    const ext = isVideo ? 'mp4' : 'jpg';

    // Step 6: Upload to Supabase
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
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
    return res.status(500).json({ 
      error: 'Download failed', 
      message: err.response?.status || err.message
    });
  }
}
