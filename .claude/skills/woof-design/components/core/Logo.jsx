import React from "react";
/** Woof mark. variant: "mark" (auto lavender/charcoal via theme) | "tile". Set base to the path of assets/brand relative to the page. */
export function Logo({size=32,variant="mark",theme,base="assets/brand",withName=false,version,style}){
  const isLight=theme==="light"||(theme==null&&typeof document!=="undefined"&&document.documentElement.getAttribute("data-theme")==="light");
  const file=variant==="tile"?(isLight?"tile-light.svg":"tile-dark.svg"):(isLight?"woof-ink.svg":"woof.svg");
  const img=<img src={base+"/"+file} alt="Woof" width={size} height={size} style={{display:"block",borderRadius:variant==="tile"?size*0.0625:0}}/>;
  if(!withName) return <span style={{display:"inline-flex",...style}}>{img}</span>;
  return <span style={{display:"inline-flex",alignItems:"center",gap:Math.round(size*0.3),...style}}>{img}<span style={{font:"var(--type-heading)",fontSize:Math.max(14,Math.round(size*0.5)),color:"var(--text-primary)"}}>Woof</span>{version&&<span style={{font:"var(--type-mono-sm)",color:"var(--text-muted)"}}>{version}</span>}</span>;
}
