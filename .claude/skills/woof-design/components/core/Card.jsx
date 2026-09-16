import React from "react";
export function Card({title,actions,children,padding=12,style,bodyStyle}){
  return <section style={{background:"var(--bg-surface)",border:"1px solid var(--border-default)",borderRadius:"var(--radius-md)",overflow:"hidden",...style}}>{(title||actions)&&<header style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,minHeight:32,padding:"0 12px",borderBottom:"1px solid var(--border-subtle)"}}><span style={{font:"var(--type-label)",letterSpacing:"var(--tracking-wide)",textTransform:"uppercase",color:"var(--text-muted)"}}>{title}</span><span style={{display:"flex",gap:4}}>{actions}</span></header>}<div style={{padding,...bodyStyle}}>{children}</div></section>;
}
