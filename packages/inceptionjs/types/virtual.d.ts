// For Vite projects: `/// <reference types="inceptionjs/types/virtual" />` or
// add "inceptionjs/types/virtual" to compilerOptions.types.
declare module 'virtual:inceptionjs/config' {
  const config: { engineUrl: string; binaryenUrl: string; relayUrl: string | null };
  export default config;
}
