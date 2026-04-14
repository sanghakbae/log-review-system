import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: './',
    plugins: [react()],
    define: {
      'import.meta.env.OPENAI_API_KEY': JSON.stringify(env.OPENAI_API_KEY ?? ''),
      'import.meta.env.OPENAI_MODEL': JSON.stringify(env.OPENAI_MODEL ?? ''),
      'import.meta.env.LLM_PROVIDER': JSON.stringify(env.LLM_PROVIDER ?? ''),
    },
  };
});
