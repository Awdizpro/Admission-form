import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins:[react()], server:{ port:3002, host:true },preview: {
    host: true, // allow access from external IPs
    port: 3002,
    allowedHosts: ['admissions.awdizplacements.in'] }
   })