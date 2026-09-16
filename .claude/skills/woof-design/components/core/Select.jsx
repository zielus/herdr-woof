import React from "react";
import {Icon} from "./Icon.jsx";
export function Select({value,onChange,options=[],mono,disabled,width,style}){
  return <span style={{position:"relative",display:"inline-flex",width:width||"auto",...style}}><select value={value} onChange={onChange} disabled={disabled} style={{appearance:"none",WebkitAppearance:"none",height:"var(--control-height)",padding:"0 28px 0 10px",width:"100%",borderRadius:"var(--radius-md)",border:"1px solid var(--border-default)",background:"var(--bg-raised)",color:"var(--text-primary)",font:mono?"var(--type-mono-sm)":"var(--type-small)",cursor:disabled?"not-allowed":"pointer",opacity:disabled?.45:1}}>{options.map(o=>typeof o==="string"?<option key={o} value={o}>{o}</option>:<option key={o.value} value={o.value}>{o.label}</option>)}</select><Icon name="chevronDown" size={14} color="var(--text-muted)" style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}}/></span>;
}
