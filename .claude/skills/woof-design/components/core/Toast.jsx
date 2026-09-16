import React from "react";
import {Icon} from "./Icon.jsx";
export function Toast({tone="neutral",title,detail,action,onDismiss,style}){
  const c=tone==="neutral"?"var(--text-secondary)":"var(--state-"+tone+")";
  return <div role="status" style={{display:"grid",gridTemplateColumns:"16px minmax(0,1fr) auto",gap:10,alignItems:"start",width:360,padding:"10px 12px",background:"var(--bg-raised)",border:"1px solid var(--border-default)",borderLeft:"1px solid var(--border-default)",borderRadius:"var(--radius-md)",boxShadow:"var(--shadow-1)",...style}}><Icon name={tone==="fail"||tone==="blocked"?"alert":tone==="pass"?"check":"info"} size={16} color={c} style={{marginTop:1}}/><div><div style={{font:"var(--type-small)",fontWeight:500,color:"var(--text-primary)"}}>{title}</div>{detail&&<div style={{font:"var(--type-mono-sm)",color:"var(--text-muted)",marginTop:2}}>{detail}</div>}</div><div style={{display:"flex",gap:4}}>{action}{onDismiss&&<button type="button" onClick={onDismiss} aria-label="Dismiss" style={{all:"unset",cursor:"pointer",color:"var(--text-muted)",display:"grid",placeItems:"center",width:20,height:20}}><Icon name="x" size={12}/></button>}</div></div>;
}
