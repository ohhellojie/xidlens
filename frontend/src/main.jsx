import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import css from './prototype.css?inline';
import extra from './integration.css?inline';
let root;
export function mount(host,options){
 if(root)root.unmount();
 const shadow=host.attachShadow({mode:'open'});
 const style=document.createElement('style');style.textContent=css+extra;shadow.append(style);
 const body=document.createElement('div');body.className='knowledge-mount';shadow.append(body);
 root=createRoot(body);root.render(<App {...options}/>);
}
export function unmount(){if(root){root.unmount();root=null}}
