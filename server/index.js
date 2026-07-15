const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Persistent cookie storage (survives between requests)
let cookieJar = '';
let wireId = '';
let checksum = '';

async function refreshSession() {
  try {
    const resp = await axios.get('https://bravedown.com/facebook-story-downloader', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36' }
    });
    
    const cookies = resp.headers['set-cookie'] || [];
    cookieJar = cookies.map(c => c.split(';')[0]).join('; ');
    
    wireId = (resp.data.match(/wire:id\s*=\s*"([^"]+)"/) || [])[1] || wireId;
    checksum = (resp.data.match(/"checksum"\s*:\s*"([a-f0-9]{64})"/) || [])[1] || checksum;
    
    console.log('Session refreshed');
  } catch (e) {
    console.error('Session refresh failed:', e.message);
  }
}

// Refresh session every 30 minutes
refreshSession();
setInterval(refreshSession, 30 * 60 * 1000);

app.post('/api/download', async (req, res) => {
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No link' });

  try {
    if (!cookieJar || !wireId) await refreshSession();

    const payload = {
      _token: '',
      components: [{
        snapshot: JSON.stringify({
          data: { zlinkz: null, render_mode: false, stream_vid: false, stream_thumb: true, data: null, status: null, message: null },
          memo: { id: wireId, name: 'public.tool.downloader-public', path: 'facebook-story-downloader', method: 'GET', release: 'a-a-a', children: [], scripts: ['25050802-0'], assets: [], errors: [], locale: 'en' },
          checksum: checksum
        }),
        updates: { zlinkz: storyLink },
        calls: [{ path: '', method: 'onDownload', params: [] }]
      }]
    };

    const resp = await axios.post('https://bravedown.com/livewire/update', payload, {
      headers: {
        'Content-type': 'application/json',
        'X-Livewire': '',
        'Cookie': cookieJar,
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://bravedown.com/facebook-story-downloader',
        'Origin': 'https://bravedown.com'
      },
      timeout: 25000
    });

    const snap = JSON.parse(resp.data.components[0].snapshot);
    const downloadUrl = snap?.data?.data?.[0]?.links?.[0]?.[0]?.[0]?.[0]?.url;

    if (!downloadUrl) return res.status(400).json({ error: 'No download URL' });

    // Download and upload
    const mediaResp = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const contentType = mediaResp.headers['content-type'] || 'image/jpeg';
    
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const ext = contentType.includes('video') ? 'mp4' : 'jpg';
    const fileName = `stories/${Date.now()}.${ext}`;
    
    await supabase.storage.from('story-media').upload(fileName, mediaResp.data, { contentType, upsert: true });
    const { data: { publicUrl } } = supabase.storage.from('story-media').getPublicUrl(fileName);
    
    await supabase.from('stories').insert({
      original_link: storyLink,
      media_url: publicUrl,
      media_type: contentType.includes('video') ? 'video' : 'image'
    });

    return res.json({ success: true, mediaUrl: publicUrl });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
