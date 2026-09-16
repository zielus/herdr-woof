import React from "react";
export function Badge({children,tone="neutral",mono=true,style}){
  const c=tone==="accent"?{bg:"var(--accent-subtle)",fg:"var(--accent-text)"}:{bg:"var(--bg-raised)",fg:"var(--text-secondary)"};
  return <span style={{display:"inline-flex",alignItems:"center",height:18,padding:"0 6px",borderRadius:"var(--radius-sm)",border:"1px solid "+(tone==="accent"?"transparent":"var(--border-subtle)"),background:c.bg,color:c.fg,font:mono?"var(--type-mono-sm)":"var(--type-label)",fontSize:11,lineHeight:1,whiteSpace:"nowrap",...style}}>{children}</span>;
}
