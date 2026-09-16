import React from "react";
const FAMILY=t=>t.startsWith("gate.")?"pass":t==="submission.rejected"?"fail":t==="run.blocked"?"blocked":t==="run.terminated"?"lost":t.startsWith("run.")||t.startsWith("agent.")?"working":null;
/** One journal record: seq ts type subject data */
export function JournalLine({seq,ts,type,subject,data,decision,selected,onClick,style}){
  let fam=FAMILY(type);if(type==="gate.recorded"&&decision==="reject")fam="fail";if(type==="run.terminated"&&data&&data.outcome==="completed")fam="pass";if(type==="run.terminated"&&data&&(data.outcome==="failed"))fam="fail";
  const subj=subject?[subject.agentId,subject.stageId&&(subject.stageId+" v"+subject.visit+" a"+subject.attempt)].filter(Boolean).join(" · "):"";
  const t=ts?ts.slice(11,23):"";
  return <div onClick={onClick} style={{display:"grid",gridTemplateColumns:"40px 96px 180px minmax(0,1fr)",gap:12,alignItems:"baseline",padding:"3px 12px",font:"var(--type-mono-sm)",lineHeight:"20px",background:selected?"var(--accent-subtle)":"transparent",boxShadow:selected?"inset 2px 0 0 var(--accent)":"none",cursor:onClick?"pointer":"default",...style}}><span style={{color:"var(--text-faint)",textAlign:"right"}}>{seq}</span><span style={{color:"var(--text-muted)"}}>{t}</span><span style={{color:fam?"var(--state-"+fam+")":"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{type}</span><span style={{color:"var(--text-secondary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{subj}{data&&Object.keys(data).length>0&&<span style={{color:"var(--text-muted)"}}>{(subj?"  ":"")+JSON.stringify(data)}</span>}</span></div>;
}
