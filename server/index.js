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
    console.log('🔄 Refreshing session...');
    const resp = await axios.get('https://bravedown.com/facebook-story-downloader', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 15000
    });

    // Get ALL cookies
    const setCookies = resp.headers['set-cookie'] || [];
    cookieJar = setCookies.map(c => c.split(';')[0]).join('; ');
    console.log('Cookies saved:', cookieJar.length, 'chars');

    // Extract wire:id
    const wireMatch = resp.data.match(/wire:id="([^"]+)"/i);
    if (wireMatch) wireId = wireMatch[1];
    console.log('Wire ID:', wireId?.slice(0, 30) || 'NOT FOUND');

    // Extract checksum
    const csMatch = resp.data.match(/"checksum"\s*:\s*"([a-f0-9]{64})"/i);
    if (csMatch) checksum = csMatch[1];
    console.log('Checksum:', checksum?.slice(0, 30) || 'NOT FOUND');

    // Extract CSRF token from cookie directly
    const xsrfCookie = setCookies.find(c => c.includes('XSRF-TOKEN'));
    if (xsrfCookie) {
      const match = xsrfCookie.match(/XSRF-TOKEN=([^;]+)/);
      if (match) {
        csrfToken = decodeURIComponent(match[1]);
      }
    }
    console.log('CSRF Token:', csrfToken?.slice(0, 50) || 'NOT FOUND');

    console.log('✅ Session ready');
    return true;
  } catch (e) {
    console.error('❌ Session refresh failed:', e.message);
    return false;
  }
}

// Init on startup
refreshSession();
setInterval(refreshSession, 30 * 60 * 1000);

app.post('/api/download', async (req, res) => {
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No link' });

  try {
    if (!cookieJar || !wireId || !checksum || !csrfToken) {
      console.log('Session missing, refreshing...');
      const ok = await refreshSession();
      if (!ok) return res.status(500).json({ error: 'Failed to initialize session' });
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
      _token: csrfToken,
      components: [{
        snapshot: snapshot,
        updates: { zlinkz: storyLink },
        calls: [{ path: '', method: 'onDownload', params: [] }]
      }]
    };

    console.log('📤 Sending download request...');
    
    const resp = await axios.post('https://bravedown.com/livewire/update', payload, {
      headers: {
        'Content-type': 'application/json;charset=UTF-8',
        'X-Livewire': '',
        'X-XSRF-TOKEN': csrfToken,
        'Cookie': cookieJar,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Referer': 'https://bravedown.com/facebook-story-downloader',
        'Origin': 'https://bravedown.com'
      },
      timeout: 25000,
      validateStatus: s => true
    });

    console.log('📥 Response status:', resp.status);

    if (resp.status !== 200) {
      console.log('Response body:', resp.data?.toString()?.slice(0, 300));
      return res.status(resp.status).json({ error: `BraveDown returned ${resp.status}` });
    }

    const snapData = JSON.parse(resp.data.components[0].snapshot);
    const storyData = snapData?.data?.data;
    
    let downloadUrl = null;
    if (storyData && storyData[0] && storyData[0].links) {
      try {
        downloadUrl = storyData[0].links[0][0][0][0].url;
      } catch (e) {
        console.log('URL extraction failed');
      }
    }

    if (!downloadUrl) {
      return res.status(400).json({ error: 'No download URL in response' });
    }

    console.log('✅ Download URL found');

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

    const { data } = supabase.storage.from('story-media').getPublicUrl(fileName);
    
    await supabase.from('stories').insert({
      original_link: storyLink,
      media_url: data.publicUrl,
      media_type: isVideo ? 'video' : 'image'
    });

    console.log('✅ Success!');
    return res.json({ success: true, mediaUrl: data.publicUrl, type: isVideo ? 'video' : 'image' });

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server running on port', PORT));
