import {defineConfig} from 'vite';
export default defineConfig({define:{'process.env.NODE_ENV':JSON.stringify('production')},build:{outDir:'../app/knowledge',emptyOutDir:true,lib:{entry:'src/main.jsx',name:'XidKnowledge',formats:['iife'],fileName:()=> 'knowledge.js'},minify:true}});
