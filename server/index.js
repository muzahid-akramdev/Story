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
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 15000
    });

    const html = resp.data;
    const setCookies = resp.headers['set-cookie'] || [];
    
    // Save ALL cookies
    cookieJar = setCookies.map(c => c.split(';')[0]).join('; ');
    console.log('Cookie count:', setCookies.length);

    // Extract wire:id
    const wireMatch = html.match(/wire:id="([^"]+)"/i);
    wireId = wireMatch ? wireMatch[1] : '';
    console.log('Wire ID:', wireId);

    // Extract checksum
    const csMatch = html.match(/"checksum"\s*:\s*"([a-f0-9]{64})"/i);
    checksum = csMatch ? csMatch[1] : '';
    console.log('Checksum found:', !!checksum);

    // Extract DECRYPTED CSRF token from Livewire script in page
    // Look for: csrf_token: "TOKEN"
    const tokenMatch = html.match(/csrf_token["\s:]+([A-Za-z0-9]+)/i);
    if (tokenMatch) {
      csrfToken = tokenMatch[1];
      console.log('CSRF from script:', csrfToken);
    }

    // Fallback: look in meta tag
    if (!csrfToken) {
      const metaMatch = html.match(/<meta[^>]+csrf-token[^>]+content="([^"]+)"/i);
      if (metaMatch) {
        csrfToken = metaMatch[1];
        console.log('CSRF from meta:', csrfToken);
      }
    }

    // Last resort: decode XSRF cookie
    if (!csrfToken) {
      const xsrfCookie = setCookies.find(c => c.includes('XSRF-TOKEN'));
      if (xsrfCookie) {
        const match = xsrfCookie.match(/XSRF-TOKEN=([^;]+)/);
        if (match) {
          try {
            csrfToken = decodeURIComponent(match[1]);
            console.log('CSRF from cookie (decoded):', csrfToken.slice(0, 50));
          } catch(e) {}
        }
      }
    }

    console.log('Session ready, token length:', csrfToken?.length || 0);
    return true;
  } catch (e) {
    console.error('Session failed:', e.message);
    return false;
  }
}

refreshSession();
setInterval(refreshSession, 30 * 60 * 1000);

app.post('/api/download', async (req, res) => {
  const { storyLink } = req.body;
  if (!storyLink) return res.status(400).json({ error: 'No link' });

  try {
    if (!cookieJar || !wireId || !csrfToken) {
      await refreshSession();
      if (!cookieJar || !wireId || !csrfToken) {
        return res.status(500).json({ error: 'Session init failed' });
      }
    }

    const payload = {
      _token: csrfToken,
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
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'Referer': 'https://bravedown.com/facebook-story-downloader',
        'Origin': 'https://bravedown.com'
      },
      timeout: 25000,
      validateStatus: s => true
    });

    if (resp.status !== 200) {
      console.log('Status:', resp.status, 'Body:', (resp.data+'').slice(0, 200));
      // Try refreshing session once
      await refreshSession();
      return res.status(resp.status).json({ error: `Failed: ${resp.status}` });
    }

    const snapData = JSON.parse(resp.data.components[0].snapshot);
    const downloadUrl = snapData?.data?.data?.[0]?.links?.[0]?.[0]?.[0]?.[0]?.url;

    if (!downloadUrl) {
      return res.status(400).json({ error: 'No download URL' });
    }

    // Download and upload
    const mediaResp = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const contentType = mediaResp.headers['content-type'] || 'image/jpeg';
    const isVideo = contentType.includes('video');
    const ext = isVideo ? 'mp4' : 'jpg';

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const fileName = `stories/${Date.now()}.${ext}`;
    
    await supabase.storage.from('story-media').upload(fileName, mediaResp.data, { contentType, upsert: true });
    const { data } = supabase.storage.from('story-media').getPublicUrl(fileName);
    
    await supabase.from('stories').insert({
      original_link: storyLink,
      media_url: data.publicUrl,
      media_type: isVideo ? 'video' : 'image'
    });

    return res.json({ success: true, mediaUrl: data.publicUrl, type: isVideo ? 'video' : 'image' });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on', PORT));
