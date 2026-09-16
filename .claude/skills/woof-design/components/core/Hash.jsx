import React,{useState} from "react";
import {Icon} from "./Icon.jsx";
export function Hash({value,length=12,copy=true,prefix,style}){
  const [ok,setOk]=useState(false);
  const short=value?value.slice(0,length):"—";
  const doCopy=e=>{e.stopPropagation();if(navigator.clipboard&&value)navigator.clipboard.writeText(value);setOk(true);setTimeout(()=>setOk(false),1200)};
  return <span title={value} style={{display:"inline-flex",alignItems:"center",gap:4,font:"var(--type-mono-sm)",color:"var(--text-secondary)",...style}}>{prefix&&<span style={{color:"var(--text-muted)"}}>{prefix}</span>}<span>{short}{value&&value.length>length?"…":""}</span>{copy&&value&&<button type="button" onClick={doCopy} aria-label="Copy" style={{all:"unset",display:"grid",placeItems:"center",width:16,height:16,cursor:"pointer",color:ok?"var(--state-pass)":"var(--text-muted)"}}><Icon name={ok?"check":"copy"} size={11}/></button>}</span>;
}
