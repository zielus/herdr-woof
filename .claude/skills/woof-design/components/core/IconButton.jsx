import React,{useState} from "react";
import {Icon} from "./Icon.jsx";
export function IconButton({icon,label,size="md",active,disabled,onClick,style}){
  const [h,setH]=useState(false);const s=size==="sm"?24:28;
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)} style={{width:s,height:s,display:"inline-grid",placeItems:"center",borderRadius:"var(--radius-md)",border:"1px solid transparent",background:active?"var(--accent-subtle)":h?"var(--bg-hover)":"transparent",color:active?"var(--accent-text)":"var(--text-secondary)",cursor:disabled?"not-allowed":"pointer",opacity:disabled?.45:1,transition:"background var(--duration-fast)",...style}}><Icon name={icon} size={size==="sm"?14:16}/></button>;
}
