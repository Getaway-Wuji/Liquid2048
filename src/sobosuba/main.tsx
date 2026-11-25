import { createRoot } from 'react-dom/client';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import App from './App';
import './sobosuba.css';

const root = document.getElementById('root');
if (!root) throw new Error('sobosuba requires a root element');
createRoot(root).render(<App />);
