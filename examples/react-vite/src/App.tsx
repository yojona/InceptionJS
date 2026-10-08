import { useRef, useState, type FormEvent } from 'react';
import { InceptionView, type InceptionViewHandle } from '@inceptionjs/react';
import config from 'virtual:inceptionjs/config';

export function App() {
  const view = useRef<InceptionViewHandle>(null);
  const [address, setAddress] = useState('https://example.com/');
  const [title, setTitle] = useState('');
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });

  const go = (e: FormEvent) => {
    e.preventDefault();
    view.current?.navigate(address);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', font: '14px system-ui, sans-serif' }}>
      <form onSubmit={go} style={{ display: 'flex', gap: 8, padding: 8, background: '#f4f4f5' }}>
        <button type="button" aria-label="Atrás" disabled={!nav.canGoBack} onClick={() => view.current?.back()}>&larr;</button>
        <button type="button" aria-label="Adelante" disabled={!nav.canGoForward} onClick={() => view.current?.forward()}>&rarr;</button>
        <button type="button" aria-label="Recargar" onClick={() => view.current?.reload()}>&#x21bb;</button>
        <input aria-label="Dirección" value={address} onChange={(e) => setAddress(e.target.value)} style={{ flex: 1, padding: '6px 8px' }} />
        <button>Ir</button>
      </form>
      <InceptionView
        ref={view}
        src="https://example.com/"
        engineUrl={config.engineUrl}
        binaryenUrl={config.binaryenUrl}
        relayUrl={config.relayUrl ?? ''}
        style={{ flex: 1, width: '100%', height: 'auto' }}
        onNavigate={(e) => setAddress(e.detail.url)}
        onTitle={(e) => {
          setTitle(e.detail.title);
          document.title = e.detail.title || 'InceptionJS en React';
        }}
        onNavigationState={(e) => setNav(e.detail)}
        onCrash={(e) => console.error('el motor falló:', e.detail.reason)}
      />
      <footer style={{ padding: '4px 8px', color: '#555' }}>{title}</footer>
    </div>
  );
}
