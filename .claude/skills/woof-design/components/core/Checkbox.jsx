import React from "react";
import {Icon} from "./Icon.jsx";
export function Checkbox({checked,onChange,label,disabled,style}){
  return <label style={{display:"inline-flex",alignItems:"center",gap:8,cursor:disabled?"not-allowed":"pointer",opacity:disabled?.45:1,font:"var(--type-small)",color:"var(--text-primary)",...style}}><input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} style={{position:"absolute",opacity:0,width:0,height:0}}/><span style={{width:14,height:14,borderRadius:"var(--radius-sm)",border:"1px solid "+(checked?"var(--accent)":"var(--border-strong)"),background:checked?"var(--accent)":"var(--bg-inset)",display:"grid",placeItems:"center",transition:"background var(--duration-fast)"}}>{checked&&<Icon name="check" size={10} color="var(--on-accent)" strokeWidth={2.5}/>}</span>{label}</label>;
}
