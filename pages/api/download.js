import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No story link provided' });

  try {
    // Step 1: Get fresh page for cookies and current token
    const pageResp = await axios.get('https://bravedown.com/facebook-story-downloader', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    // Get all cookies as a single string
    const setCookieHeader = pageResp.headers['set-cookie'];
    let cookieString = '';
    if (setCookieHeader) {
      cookieString = setCookieHeader.map(c => c.split(';')[0]).join('; ');
    }

    // Extract wire:id from HTML
    const wireIdMatch = pageResp.data.match(/wire:id\s*=\s*"([^"]+)"/);
    const wireId = wireIdMatch ? wireIdMatch[1] : '';

    // Extract checksum
    const checksumMatch = pageResp.data.match(/"checksum"\s*:\s*"([a-f0-9]{64})"/);
    const checksum = checksumMatch ? checksumMatch[1] : '';

    // Build the exact payload
    const snapshotData = {
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
    };

    const payload = {
      _token: '',
      components: [{
        snapshot: JSON.stringify(snapshotData),
        updates: { zlinkz: storyLink },
        calls: [{ path: '', method: 'onDownload', params: [] }]
      }]
    };

    // Try with cookie
    const response = await axios.post('https://bravedown.com/livewire/update', payload, {
      headers: {
        'Content-type': 'application/json',
        'X-Livewire': '',
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Referer': 'https://bravedown.com/facebook-story-downloader',
        'Origin': 'https://bravedown.com'
      },
      timeout: 25000,
      validateStatus: status => true
    });

    if (response.status !== 200) {
      return res.status(response.status).json({ 
        error: `BraveDown returned ${response.status}`,
        debug: response.data?.toString().slice(0, 300)
      });
    }

    // Parse response
    const respData = response.data;
    let downloadUrl = null;

    if (respData.components?.[0]?.snapshot) {
      const snap = JSON.parse(respData.components[0].snapshot);
      const data = snap?.data?.data;
      if (data?.[0]?.links?.[0]?.[0]?.[0]?.[0]?.url) {
        downloadUrl = data[0].links[0][0][0][0].url;
      }
    }

    if (!downloadUrl) {
      return res.status(400).json({ error: 'No download URL in response' });
    }

    // Download media
    const mediaResp = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const contentType = mediaResp.headers['content-type'] || 'image/jpeg';
    const isVideo = contentType.includes('video');
    const ext = isVideo ? 'mp4' : 'jpg';

    // Upload to Supabase
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const fileName = `stories/${Date.now()}.${ext}`;
    
    await supabase.storage.from('story-media').upload(fileName, mediaResp.data, {
      contentType, upsert: true
    });

    const { data: { publicUrl } } = supabase.storage.from('story-media').getPublicUrl(fileName);

    await supabase.from('stories').insert({
      original_link: storyLink,
      media_url: publicUrl,
      media_type: isVideo ? 'video' : 'image'
    });

    return res.status(200).json({ success: true, mediaUrl: publicUrl, type: isVideo ? 'video' : 'image' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
