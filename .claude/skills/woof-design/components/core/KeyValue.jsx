import React from "react";
/** items: [{k, v, mono}] */
export function KeyValue({items=[],columns=1,labelWidth=140,style}){
  return <dl style={{display:"grid",gridTemplateColumns:"repeat("+columns+", minmax(0,1fr))",gap:"6px 24px",margin:0,...style}}>{items.map((it,i)=><div key={i} style={{display:"grid",gridTemplateColumns:labelWidth+"px minmax(0,1fr)",gap:12,alignItems:"baseline",minHeight:20}}><dt style={{font:"var(--type-small)",color:"var(--text-muted)",margin:0}}>{it.k}</dt><dd style={{margin:0,font:it.mono===false?"var(--type-small)":"var(--type-mono-sm)",color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.v}</dd></div>)}</dl>;
}
