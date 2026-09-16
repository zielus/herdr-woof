Vertical stage-visit timeline; each visit lists its attempts (a1, a2…) with cause, agent and verdict.

```jsx
<Timeline items={snapshot.stages.flatMap(s=>s.visits.map(v=>({stageId:s.stageId,...v})))} />
```

Dot color = visit status. Attempt keys are `stage/visit/attempt`.
