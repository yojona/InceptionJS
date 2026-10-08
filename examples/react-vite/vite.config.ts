import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import inception from 'inceptionjs/vite';

// INCEPTION_ENGINE_DIR points at a built engine (inception-engine.{js,wasm,data}).
export default defineConfig({
  plugins: [react(), inception({ relay: true })],
});
