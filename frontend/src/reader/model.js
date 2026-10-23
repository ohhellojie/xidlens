export const clamp=(n,low,high)=>Math.min(high,Math.max(low,n));
export const defaults=()=>({top:1,offset:0,left:0,selected:1,query:'',wrap:false});
export function sanitize(value,total){return {...defaults(),...value,top:clamp(Math.trunc(value?.top)||1,1,Math.max(1,total)),selected:clamp(Math.trunc(value?.selected)||1,1,Math.max(1,total)),offset:Math.max(0,Number(value?.offset)||0),query:typeof value?.query==='string'?value.query.slice(0,512):''};}
export function advance(position,delta,total,height){
 let top=clamp(position.top,1,Math.max(1,total)),offset=position.offset+delta;
 while(offset<0&&top>1){top--;offset+=height(top);}
 while(offset>=height(top)&&top<total){offset-=height(top);top++;}
 return {top,offset:clamp(offset,0,Math.max(0,height(top)-1))};
}
export function endPosition(total,viewport,height){return advance({top:Math.max(1,total),offset:height(Math.max(1,total))},-viewport,total,height);}
export function boundPosition(position,total,viewport,height){const end=endPosition(total,viewport,height);return position.top>end.top||position.top===end.top&&position.offset>end.offset?end:position;}
export function expandTabs(value){let col=0;return value.replace(/[^\t]|\t/g,c=>{if(c==='\t'){const n=8-col%8;col+=n;return ' '.repeat(n);}col++;return c;});}
export function highlightParts(text,query){
 if(!query)return [text];const lower=text.toLowerCase(),needle=query.toLowerCase(),parts=[];let from=0,at;
 while(parts.length<4000&&(at=lower.indexOf(needle,from))!==-1){parts.push(text.slice(from,at),{match:text.slice(at,at+query.length)});from=at+query.length;}
 parts.push(text.slice(from));return parts;
}
