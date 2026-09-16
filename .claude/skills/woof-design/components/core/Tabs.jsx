import React from "react";
import {Badge} from "./Badge.jsx";
export function Tabs({tabs=[],value,onChange,style}){
  return <div role="tablist" style={{display:"flex",gap:2,borderBottom:"1px solid var(--border-subtle)",...style}}>{tabs.map(t=>{const o=typeof t==="string"?{id:t,label:t}:t;const on=o.id===value;return <button key={o.id} role="tab" aria-selected={on} type="button" onClick={()=>onChange&&onChange(o.id)} style={{all:"unset",display:"inline-flex",alignItems:"center",gap:6,height:32,padding:"0 10px",marginBottom:-1,font:"var(--type-small)",fontWeight:500,color:on?"var(--text-primary)":"var(--text-muted)",borderBottom:"2px solid "+(on?"var(--accent)":"transparent"),cursor:"pointer",transition:"color var(--duration-fast)"}}>{o.label}{o.count!=null&&<Badge>{o.count}</Badge>}</button>})}</div>;
}
