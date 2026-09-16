import React from "react";
import {Icon} from "./Icon.jsx";
export function Tag({children,onRemove,style}){
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,height:22,padding:"0 4px 0 8px",borderRadius:"var(--radius-sm)",border:"1px solid var(--border-default)",background:"var(--bg-surface)",color:"var(--text-primary)",font:"var(--type-mono-sm)",...style}}>{children}{onRemove&&<button type="button" onClick={onRemove} aria-label="Remove" style={{all:"unset",display:"grid",placeItems:"center",width:16,height:16,borderRadius:3,cursor:"pointer",color:"var(--text-muted)"}}><Icon name="x" size={11}/></button>}</span>;
}
