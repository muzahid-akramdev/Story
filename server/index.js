const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

let cookieJar = '';
let wireId = '';
let checksum = '';
let csrfToken = '';

async function refreshSession() {
  try {
    console.log('Refreshing session...');
    const resp = await axios.get('https://bravedown.com/facebook-story-downloader', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 15000
    });

    // Save cookies
    const cookies = resp.headers['set-cookie'] || [];
    cookieJar = cookies.map(c => c.split(';')[0]).join('; ');
    console.log('Cookies:', cookieJar.slice(0, 100));

    // Extract wire:id
    const wireMatch = resp.data.match(/wire:id\s*=\s*"([^"]+)"/i);
    wireId = wireMatch ? wireMatch[1] : wireId;
    console.log('Wire ID:', wireId);

    // Extract checksum - try multiple patterns
    const csMatch = resp.data.match(/"checksum"\s*:\s*"([a-f0-9]{64})"/i)
      || resp.data.match(/checksum['"]?\s*:\s*['"]([a-f0-9]{64})['"]/i);
    checksum = csMatch ? csMatch[1] : checksum;
    console.log('Checksum:', checksum?.slice(0, 20));

    // Extract CSRF token
    const tokenMatch = resp.data.match(/csrf_token['"]?\s*:\s*['"]([^'"]+)['"]/i)
      || resp.data.match(/"token":"([^"]+)"/i)
      || resp.data.match(/XSRF-TOKEN[^=]+=([^;]+)/i);
    if (tokenMatch) {
      csrfToken = tokenMatch[1];
      // URL decode if needed
      try { csrfToken = decodeURIComponent(csrfToken); } catch(e) {}
    }
    console.log('CSRF Token:', csrfToken?.slice(0, 30));

    console.log('Session refreshed successfully');
  } catch (e) {
    console.error('Session refresh failed:', e.message);
  }
}

// Refresh immediately and every 30 min
refreshSession();
setInterval(refreshSession, 30 * 60 * 1000);

app.post('/api/download', async (req, res) => {
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No link' });

  try {
    if (!cookieJar || !wireId || !checksum) {
      await refreshSession();
    }

    if (!cookieJar || !wireId || !checksum) {
      return res.status(500).json({ error: 'Failed to initialize session' });
    }

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
      _token: csrfToken || '',
      components: [{
        snapshot: snapshot,
        updates: { zlinkz: storyLink },
        calls: [{ path: '', method: 'onDownload', params: [] }]
      }]
    };

    console.log('Sending request with wireId:', wireId, 'checksum:', checksum?.slice(0,20));

    const resp = await axios.post('https://bravedown.com/livewire/update', payload, {
      headers: {
        'Content-type': 'application/json;charset=UTF-8',
        'X-Livewire': '',
        'Cookie': cookieJar,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Referer': 'https://bravedown.com/facebook-story-downloader',
        'Origin': 'https://bravedown.com'
      },
      timeout: 25000
    });

    console.log('Response status:', resp.status);

    const snapData = JSON.parse(resp.data.components[0].snapshot);
    const downloadUrl = snapData?.data?.data?.[0]?.links?.[0]?.[0]?.[0]?.[0]?.url;

    if (!downloadUrl) {
      console.log('Response:', JSON.stringify(resp.data).slice(0, 500));
      return res.status(400).json({ error: 'No download URL in response' });
    }

    console.log('Download URL found');

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
    
    const { error: uploadError } = await supabase.storage
      .from('story-media')
      .upload(fileName, mediaResp.data, { contentType, upsert: true });
    
    if (uploadError) {
      console.error('Upload error:', uploadError);
      return res.status(500).json({ error: 'Upload failed' });
    }

    const { data: { publicUrl } } = supabase.storage.from('story-media').getPublicUrl(fileName);
    
    await supabase.from('stories').insert({
      original_link: storyLink,
      media_url: publicUrl,
      media_type: isVideo ? 'video' : 'image'
    });

    return res.json({ success: true, mediaUrl: publicUrl, type: isVideo ? 'video' : 'image' });

  } catch (err) {
    console.error('Download error:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data).slice(0, 500));
    }
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
