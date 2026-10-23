import {defineConfig} from 'vite';
export default defineConfig({define:{'process.env.NODE_ENV':JSON.stringify('production')},build:{outDir:'../app/reader',emptyOutDir:false,lib:{entry:'src/reader/main.jsx',name:'XidReader',formats:['iife'],fileName:()=> 'reader.js'},minify:true}});
