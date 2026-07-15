import { useState } from 'react';

export default function Home() {
  const [link, setLink] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyLink: link })
      });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ error: 'Network error. Check console.' });
      console.error(err);
    }
    setLoading(false);
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 20, fontFamily: 'sans-serif' }}>
      <h1>📸 Facebook Story Archiver</h1>
      <p>Paste a <strong>public</strong> Facebook story link to download and archive it forever.</p>
      
      <input
        value={link}
        onChange={e => setLink(e.target.value)}
        placeholder="https://web.facebook.com/stories/..."
        style={{ width: '100%', padding: 10, marginBottom: 10, fontSize: 14 }}
      />
      
      <button
        onClick={handleDownload}
        disabled={loading}
        style={{ padding: '12px 24px', cursor: 'pointer', fontSize: 16, background: '#1877f2', color: 'white', border: 'none', borderRadius: 5 }}
      >
        {loading ? '⏳ Downloading...' : 'Download & Archive'}
      </button>

      {result?.error && (
        <div style={{ marginTop: 20, padding: 15, background: '#ffeaea', borderRadius: 5, color: 'red' }}>
          <strong>Error:</strong> {result.error}
          {result.message && <p style={{ fontSize: 13, marginTop: 5 }}>{result.message}</p>}
        </div>
      )}

      {result?.success && (
        <div style={{ marginTop: 25, textAlign: 'center' }}>
          {result.type === 'video' ? (
            <video
              controls
              src={result.mediaUrl}
              style={{ width: '100%', maxHeight: 400, borderRadius: 10, background: '#000' }}
            />
          ) : (
            <img
              src={result.mediaUrl}
              alt="Archived Story"
              style={{ width: '100%', maxHeight: 400, borderRadius: 10, objectFit: 'contain', background: '#f0f0f0' }}
              onError={(e) => { e.target.style.display = 'none'; setResult({ ...result, error: 'Image failed to load. The media URL might be broken.' }); }}
            />
          )}
          <p style={{ color: 'green', marginTop: 10 }}>✅ Permanently saved to your archive.</p>
        </div>
      )}
    </div>
  );
}
