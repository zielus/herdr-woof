import React from "react";
/** Status chip. state maps to the state color; tone overrides. */
const MAP={pass:"pass",completed:"pass",accepted:"pass",alive:"pass",delivered:"pass",fail:"fail",failed:"fail",rejected:"fail",reject:"fail",corrupt:"fail",blocked:"blocked",attention:"blocked",exhausted:"blocked",lost:"lost",exited:"lost",abandoned:"lost",cancelled:"lost",superseded:"lost",unhosted:"lost",idle:"idle",created:"idle",done:"pass",working:"working",running:"working",starting:"working",open:"working",ambiguous:"blocked"};
export function Chip({state,children,tone,dot=true,pulse,size="md",style}){
  const t=tone||MAP[state]||"idle";const live=pulse??(t==="working");
  return <span style={{display:"inline-flex",alignItems:"center",gap:6,height:size==="sm"?18:22,padding:size==="sm"?"0 6px":"0 8px",borderRadius:"var(--radius-pill)",background:"var(--state-"+t+"-subtle)",color:"var(--state-"+t+")",font:"var(--type-mono-sm)",fontSize:size==="sm"?11:12,fontWeight:500,whiteSpace:"nowrap",lineHeight:1,...style}}>{dot&&<span style={{width:6,height:6,borderRadius:"50%",background:"currentColor",animation:live?"woofPulse 1.2s infinite":"none"}}/>}{children??state}<style>{"@keyframes woofPulse{50%{opacity:.25}}"}</style></span>;
}
