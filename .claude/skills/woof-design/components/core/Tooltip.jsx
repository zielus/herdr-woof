import React,{useState} from "react";
export function Tooltip({label,children,side="top"}){
  const [on,setOn]=useState(false);
  const pos=side==="bottom"?{top:"calc(100% + 6px)"}:{bottom:"calc(100% + 6px)"};
  return <span onMouseEnter={()=>setOn(true)} onMouseLeave={()=>setOn(false)} style={{position:"relative",display:"inline-flex"}}>{children}{on&&<span role="tooltip" style={{position:"absolute",left:"50%",transform:"translateX(-50%)",...pos,padding:"4px 8px",background:"var(--charcoal-0)",color:"var(--charcoal-8)",border:"1px solid var(--charcoal-4)",borderRadius:"var(--radius-sm)",font:"var(--type-mono-sm)",whiteSpace:"nowrap",boxShadow:"var(--shadow-1)",zIndex:"var(--z-overlay)"}}>{label}</span>}</span>;
}
