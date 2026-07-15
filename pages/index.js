import { useState } from 'react';

export default function Home() {
  const [link, setLink] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyLink: link })
      });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      alert('Failed. Check console.');
      console.error(err);
    }
    setLoading(false);
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 20, fontFamily: 'sans-serif' }}>
      <h1>Facebook Story Archiver</h1>
      <p>Paste a public Facebook story link to download and archive it forever.</p>
      <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://web.facebook.com/stories/..." style={{ width: '100%', padding: 10, marginBottom: 10 }} />
      <button onClick={handleDownload} disabled={loading} style={{ padding: '10px 20px', cursor: 'pointer' }}>
        {loading ? 'Downloading...' : 'Download & Archive'}
      </button>
      {result?.error && <p style={{ color: 'red' }}>{result.error}</p>}
      {result?.success && (
        <div style={{ marginTop: 20 }}>
          {result.type === 'video' ? (
            <video controls src={result.mediaUrl} width="100%" />
          ) : (
            <img src={result.mediaUrl} alt="Archived Story" width="100%" />
          )}
          <p>✅ Permanently saved to your archive.</p>
        </div>
      )}
    </div>
  );
}
