import { defineConfig } from 'vite'

export default defineConfig({
  base: '/character-vj/',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        controller: 'controller.html',
      },
    },
  },
})
