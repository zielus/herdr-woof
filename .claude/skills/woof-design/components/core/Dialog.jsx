import React from "react";
import {Button} from "./Button.jsx";
import {IconButton} from "./IconButton.jsx";
export function Dialog({open,title,children,onClose,actions,width=440,inline}){
  if(!open) return null;
  const box=<div role="dialog" aria-modal="true" style={{width,maxWidth:"100%",background:"var(--bg-surface)",border:"1px solid var(--border-default)",borderRadius:"var(--radius-lg)",boxShadow:"var(--shadow-2)",overflow:"hidden"}}><header style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 12px 12px 16px",borderBottom:"1px solid var(--border-subtle)"}}><span style={{font:"var(--type-heading)",color:"var(--text-primary)"}}>{title}</span><IconButton icon="x" label="Close" onClick={onClose}/></header><div style={{padding:16,font:"var(--type-body)",color:"var(--text-secondary)"}}>{children}</div>{actions&&<footer style={{display:"flex",justifyContent:"flex-end",gap:8,padding:"12px 16px",borderTop:"1px solid var(--border-subtle)"}}>{actions}</footer>}</div>;
  if(inline) return box;
  return <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",display:"grid",placeItems:"center",zIndex:"var(--z-overlay)"}}><div onClick={e=>e.stopPropagation()}>{box}</div></div>;
}
