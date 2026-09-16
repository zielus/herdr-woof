import React,{useState} from "react";
import {Icon} from "./Icon.jsx";
export function Input({value,defaultValue,onChange,placeholder,mono,icon,invalid,disabled,width,size="md",label,hint,style,...rest}){
  const [f,setF]=useState(false);
  const box=<span style={{display:"inline-flex",alignItems:"center",gap:8,height:size==="lg"?"var(--control-height-lg)":"var(--control-height)",padding:"0 10px",width:width||"100%",borderRadius:"var(--radius-md)",border:"1px solid "+(invalid?"var(--state-fail)":f?"var(--accent-ring)":"var(--border-default)"),background:"var(--bg-inset)",color:"var(--text-primary)",boxShadow:f?"var(--focus-ring)":"none",opacity:disabled?.45:1,transition:"box-shadow var(--duration-fast)"}}>{icon&&<Icon name={icon} size={14} color="var(--text-muted)"/>}<input value={value} defaultValue={defaultValue} onChange={onChange} placeholder={placeholder} disabled={disabled} onFocus={()=>setF(true)} onBlur={()=>setF(false)} style={{all:"unset",flex:1,minWidth:0,font:mono?"var(--type-mono-sm)":"var(--type-small)",color:"inherit"}} {...rest}/></span>;
  if(!label&&!hint) return <span style={{display:"inline-flex",width:width||"100%",...style}}>{box}</span>;
  return <label style={{display:"grid",gap:6,width:width||"100%",...style}}>{label&&<span style={{font:"var(--type-small)",color:"var(--text-secondary)"}}>{label}</span>}{box}{hint&&<span style={{font:"var(--type-mono-sm)",color:invalid?"var(--state-fail)":"var(--text-muted)"}}>{hint}</span>}</label>;
}
