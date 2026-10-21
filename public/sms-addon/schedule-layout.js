/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
 const START=8*60,END=22*60,HEIGHT=END-START;
 const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3,5));
 function layoutDay(lessons){
  const events=[],outside=[];
  for(const lesson of lessons){const start=minutes(lesson.start),end=minutes(lesson.end);if(end<=START||start>=END){outside.push(lesson);continue;}const a=Math.max(START,start),b=Math.min(END,end);if(b>a)events.push({lesson,start:a,end:b,top:a-START,height:b-a,clipped:a!==start||b!==end});}
  events.sort((a,b)=>a.start-b.start||b.end-a.end||a.lesson.id.localeCompare(b.lesson.id));
  let group=[],until=-1;
  function place(){const lanes=[];for(const event of group){let lane=lanes.findIndex(end=>end<=event.start);if(lane<0)lane=lanes.length;lanes[lane]=event.end;event.lane=lane;}for(const event of group){event.lanes=lanes.length;event.left=event.lane/lanes.length;event.width=1/lanes.length;}group=[];}
  for(const event of events){if(group.length&&event.start>=until){place();until=-1;}group.push(event);until=Math.max(until,event.end);}place();return{events,outside};
 }
 globalThis.SmsScheduleLayout=Object.freeze({START,END,HEIGHT,layoutDay});
})();
