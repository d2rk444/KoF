// fighter.js — classe Fighter: estados, física, golpes, guard, poses
class Fighter{
  constructor(char,x,facing){
    this.char=char;
    this.x=x;this.y=GROUND;this.vx=0;this.vy=0;this.facing=facing;
    this.hp=1000;this.maxHp=1000;
    this.state='STAND';this.actId=char.moveMap.stand[0]??0;
    this.fi=0;this.ft=0;this.stTick=0;this.atkTimeout=0;
    this.hitFlash=0;this.inAir=false;
    this.isAtk=false;this.hasHit=false;this.atkDmg=50;this._lastHitFi=-1;this._lastHitTick=-999;
    this.comboCount=0;this.comboTimer=0;
    this.koTimer=0;this.airAtkDone=false;
    this.invFrames=0;
    // KOF2002 mechanics
    this.hitstunFrames=0;   // explicit hitstun — cannot act until 0
    this.landingLag=0;      // landing recovery frames after air attack/hit
    this.lastDmgReceived=0; // for launcher threshold
    this.airHitCount=0;     // juggle counter (limits re-launches)
    this._crouchTick=0; // [D] contador de duração do agachamento
    // Guard
    this.isGuarding=false;this.guardFrames=0;this.guardCooldown=0;
    // Knockback / bounce
    this.bounceCount=0; // how many times body has bounced on ground after aerial KO
    this.scale=char.profile.scale;
    this._standMomentumTicks=0;
    this._hitSpec=null;
    this._prof=char.profile;
    this._dmgMap=this._makeDmg();
    this._lastSpr=null;this._lastFr=null;
    this._safeSpr=null;this._safeFr=null; // only updated from stand/walk — never from attack frames
    this.snd=char.snd||new SoundPlayer(); // sound player for this fighter
    this.tauntTimer=0;this.justTaunted=0;
    this.maxMeter=METER_MAX;this.meter=METER_MAX; // começa com barra cheia
    this.hpRegenDelay=HP_REGEN_DELAY;
    this._moveSpeed=0;this.runTimer=0;
    // Pre-warm sprite cache so first frame never shows the rectangle fallback
    this._prewarm();
  }
  _moveCost(id){ if(id>=3000)return 600; if(id>=1000)return 260; return 0; }
  _canSpendFor(id){ return this.meter>=this._moveCost(id); }
  _spendFor(id){ const c=this._moveCost(id); if(c>0)this.meter=Math.max(0,this.meter-c); }
  _gainMeter(v){ this.meter=Math.max(0,Math.min(this.maxMeter,this.meter+v)); }
  _makeDmg(){
    const m=new Map(),mm=this.char.moveMap,anims=this.char.anims,meta=mm.meta||{},specs=this.char.hitDefs?.byAnimBest||new Map();
    const getDur=id=>{const f=anims.get(id);return f?animDuration(f):30;};
    const active=id=>Math.max(1,meta[id]?.activeSpan||0);
    const setHeuristic=(id,base,spanMul,maxAdd)=>m.set(id,Math.max(8,Math.round(base+Math.min(maxAdd,active(id)*spanMul))));
    mm.atkStand.forEach(id=>setHeuristic(id,18,1.8,12));
    mm.atkCrouch.forEach(id=>setHeuristic(id,20,2.0,14));
    mm.atkAir.forEach(id=>setHeuristic(id,22,2.0,14));
    mm.specials.forEach(id=>setHeuristic(id,36,2.8,22));
    mm.hypers.forEach(id=>setHeuristic(id,58,3.4,30));
    for(const [id,spec] of specs){
      if(!spec||!(spec.damage>0))continue;
      const base=Math.max(8,Math.min(180,spec.damage));
      const pause=(spec.pausetime?.[0]||0)+(spec.pausetime?.[1]||0);
      const weight=Math.min(18,Math.max(0,pause*0.35)+(spec.multiCount>1?spec.multiCount*3:0)+(spec.groundHittime||0)*0.22);
      const dmg=Math.max(8,Math.min(210,Math.round(base+weight)));
      m.set(id,dmg);
    }
    return m;
  }
  // Clear stale sprite references so the next frame always draws a fresh sprite.
  // Called by _respawn() and _nextRound() — was MISSING, causing a silent TypeError that
  // left _roundOver=true stuck forever after round 1 (root cause of "not fighting" bug).
  _resetVisualCache(){
    this._lastSpr=null;this._lastFr=null;
    this._safeSpr=null;this._safeFr=null;
    this._prewarm();
  }
  // Pre-cache first available stand sprite so _lastSpr is never null on frame 1
  _prewarm(){
    const mm=this.char.moveMap;
    const candidates=[...mm.stand,...mm.walkF];
    for(const id of candidates){
      const frs=this.char.anims.get(id);
      if(!frs?.length)continue;
      for(const fr of frs){
        const spr=this.char.sprites.get(`${fr.g},${fr.i}`);
        if(spr?.cvs){
          this._lastSpr=spr;this._lastFr=fr;
          this._safeSpr=spr;this._safeFr=fr; // safe fallback = only stand/walk sprites
          return;
        }
      }
    }
    // Absolute fallback — scan all sprites
    for(const[,spr]of this.char.sprites){
      if(spr?.cvs){
        this._lastSpr=spr;this._safeSpr=spr;return;
      }
    }
  }
  // Resolve frames for action id — use category-appropriate fallback
  frames(id){
    const f=this.char.anims.get(id);if(f?.length)return f;
    const mm=this.char.moveMap,meta=mm.meta||{};
    const attackish=id>=120;
    // Determine which pool to search based on id range
    let pool=null,maxFallbackDist=attackish?18:999999;
    if(id>=5100)        pool=mm.ko;
    else if(id>=5060)   pool=mm.fall;
    else if(id>=5000)   pool=mm.hit;
    else if(id>=3000)   pool=mm.hypers.length?mm.hypers:mm.specials;
    else if(id>=1000)   pool=mm.specials.length?mm.specials:[...mm.atkStand];
    else if(id>=600)    pool=mm.atkAir.length?mm.atkAir:mm.atkStand;
    else if(id>=400)    pool=mm.atkCrouch.length?mm.atkCrouch:mm.atkStand;
    else if(id>=300)    pool=mm.atkCrouch.length?mm.atkCrouch:mm.atkStand;
    else if(id>=200)    pool=mm.atkStand;
    else if(id>=170)    pool=mm.atkAir.length?mm.atkAir:mm.atkStand; // KOF jump atk
    else if(id>=120)    pool=mm.atkStand;  // KOF stand normals
    else if(id>=100)    pool=mm.crouch.length?mm.crouch:mm.stand;    // KOF crouch
    else if(id>=40)     pool=mm.jump;
    else if(id>=20)     pool=mm.walkF;
    else                pool=mm.stand;
    if(pool?.length){
      let best=null,bd=999999,bestId=-1;
      for(const k of pool){
        const v=this.char.anims.get(k);
        if(!v?.length)continue;
        if(attackish&&meta[k]?.usable===false)continue;
        const d=Math.abs(k-id);if(d<bd){bd=d;best=v;bestId=k;}
      }
      if(best&&bd<=maxFallbackDist){
        if(!attackish)return best;
        const src=meta[id]||{},dst=meta[bestId]||{};
        const sameTier=((id>=3000&&bestId>=3000)||(id>=1000&&id<3000&&bestId>=1000&&bestId<3000)||(id<1000&&bestId<1000));
        const sameFamily=(src.family&&dst.family&&src.family===dst.family);
        if((dst.hasHitDef||dst.hasClsn1)&&dst.usable!==false&&(sameTier||sameFamily))return best;
      }
    }
    if(attackish)return null;
    for(const[,v]of this.char.anims){if(v.length)return v;}
    return null;
  }
  setAct(id,keepFrame=false){
    // keepFrame=true: se o mesmo anim ID já está tocando, preserva fi/ft para não reiniciar do zero
    // Isso evita o efeito de arrastar quando o estado oscila (WALK_F↔WALK_B com mesma animação)
    if(keepFrame && id===this.actId)return;
    this.actId=id;this.fi=0;this.ft=0;
  }
  _canGuard(hitSpec){
    const gf=(hitSpec?.guardflag||'MA').toUpperCase();
    if(this.inAir)return gf.includes('A');
    if(this.state==='CROUCH')return gf.includes('L')||gf.includes('M');
    return gf.includes('H')||gf.includes('M')||gf.includes('A');
  }
  _hitSpecFor(id){
    return this.char.hitDefs?.byAnimBest?.get(id)||this.char.moveMap.meta?.[id]?.hitSpec||null;
  }
  setState(s,extra){
    this.state=s;this.stTick=0;this.isAtk=false;this.hasHit=false;this.atkTimeout=0;
    this.isGuarding=false;
    const mm=this.char.moveMap;
    if(s==='STAND'){
      this.setAct(rnd(mm.stand));
      this._moveSpeed=0;this.runTimer=0;
      const allowMomentum=extra?.fromHit===true||extra?.fromLanding===true||extra?.keepVx===true;
      if(extra?.stopNow===true||!allowMomentum){
        this.vx=0;this._standMomentumTicks=0;
      }else if(Math.abs(this.vx)>1.4){
        this._standMomentumTicks=Math.max(this._standMomentumTicks||0,Math.min(4,extra?.fromLanding?3:4));
      }else{
        this.vx=0;this._standMomentumTicks=0;
      }
      this.hitstunFrames=0;
    }
    else if(s==='WALK_F') {
      // BUG FIX #3/#5: preferir o ID de animação atual se ele já está em mm.walkF,
      // evitando reset desnecessário de fi/ft (e o arrastar que isso causa).
      const wfPool=mm.walkF;
      const preferredWF=wfPool.includes(this.actId)?this.actId:rnd(wfPool);
      this.setAct(preferredWF,true);
      this._standMomentumTicks=0;this._walkTarget=Math.max(3.4,this.char.profile.bodyW*0.028);this._moveSpeed=this._walkTarget;this.runTimer=0;
    }
    else if(s==='WALK_B') {
      const wbPool=mm.walkB;
      const preferredWB=wbPool.includes(this.actId)?this.actId:rnd(wbPool);
      this.setAct(preferredWB,true);
      this._standMomentumTicks=0;this._walkTarget=-Math.max(2.8,this.char.profile.bodyW*0.022);this._moveSpeed=this._walkTarget;this.runTimer=0;
    }
    else if(s==='RUN_F')  {
      const rfPool=mm.runF.length?mm.runF:mm.walkF;
      const preferredRF=rfPool.includes(this.actId)?this.actId:rnd(rfPool);
      this.setAct(preferredRF,true);
      this._standMomentumTicks=0;this._walkTarget=Math.max(6.2,this.char.profile.bodyW*0.040);this._moveSpeed=this._walkTarget;this.runTimer=extra?.dur||16;
    }
    else if(s==='RUN_B')  {
      const rbPool=mm.runB.length?mm.runB:mm.walkB;
      const preferredRB=rbPool.includes(this.actId)?this.actId:rnd(rbPool);
      this.setAct(preferredRB,true);
      this._standMomentumTicks=0;this._walkTarget=-Math.max(5.0,this.char.profile.bodyW*0.032);this._moveSpeed=this._walkTarget;this.runTimer=extra?.dur||12;
    }
    else if(s==='JUMP')   {
      this.setAct(rnd(mm.jump));this.inAir=true;
      this.vy=-13.5;this.vx=extra?.vx||0;this.airAtkDone=false;
      this.airHitCount=0;this.landingLag=0;
    }
    else if(s==='CROUCH') {
      const ca=mm.crouch.length?mm.crouch:mm.stand;
      this.setAct(rnd(ca));this.vx=0;
    }
    else if(s==='HIT')    {
      this.setAct(rnd(mm.hit));
      // KOF2002 hitstun: light=15f, medium=22f, heavy=28f
      const dmg=this.lastDmgReceived||50;
      this.hitstunFrames=dmg>80?28:dmg>50?22:15;
      // vx is already set by hit() before setState — don't touch it here
    }
    else if(s==='HIT_AIR'){
      this.setAct(mm.fall[0]??mm.hit[0]??mm.stand[0]);
      this.inAir=true;
      // Use vy already set by caller (launcher or juggle) — only default if not set
      if(extra?._vyPreset !== true){
        if(!this.vy||this.vy>-2) this.vy=-7;
        else this.vy=Math.min(this.vy-2,-4); // juggle: slightly less height
      }
      this.hitstunFrames=18;
    }
    else if(s==='KO'){
      this.setAct(mm.ko[0]??mm.hit[0]??mm.stand[0]);
      // KO body inherits vx from the killing blow (set by hit() before this call)
      // Do NOT zero vx here — the body needs to slide/fly from impact
      this.koTimer=240;this.bounceCount=0;this.hitstunFrames=0;
    }
    else if(s==='GUARD'){this.setAct(rnd(mm.stand));this.isGuarding=true;this.guardFrames=extra?.dur||22;this.vx*=0.35;this._moveSpeed=0;this.hitstunFrames=Math.max(this.hitstunFrames,extra?.stun||0);}
    else if(s==='TAUNT'){this.setAct(extra?.id??rnd(mm.taunts.length?mm.taunts:mm.stand));this.vx=0;}
  }
  // v10: toca intro/pose de vitória mesmo que a anim tenha loop (cap de ticks)
  playPose(id,cap=140){
    const frs=this.frames(id);
    if(!frs?.length)return false;
    this.state='TAUNT';this.stTick=0;this.isAtk=false;this.hasHit=false;this.setAct(id);
    this.vx=0;this._moveSpeed=0;
    this.tauntTimer=Math.max(24,Math.min(cap,Math.round(animDuration(frs)*1.15||60)));
    return true;
  }
  doTaunt(id){
    const frs=this.frames(id),meta=this.char.moveMap.meta?.[id];
    if(!frs?.length||meta?.usable===false)return false;
    this.state='TAUNT';this.stTick=0;this.isAtk=false;this.hasHit=false;this.setAct(id);
    this.tauntTimer=Math.max(18,Math.min(90,Math.round(animDuration(frs)*1.15||30)));
    this.justTaunted=24;
    return true;
  }
  doAtk(id){
    const frs=this.frames(id);
    const meta=this.char.moveMap.meta?.[id];
    const hitSpec=this._hitSpecFor(id);
    const isCmd=(meta?.fromCommand==='special'||meta?.fromCommand==='hyper');
    const hasActive=!!(meta?.hasClsn1||hitSpec||isCmd);
    if(!frs?.length||meta?.usable===false||!hasActive)return false;
    if(!this._canSpendFor(id))return false;
    this.state='ATTACK';this.stTick=0;this.isAtk=true;this.hasHit=false;this._lastHitFi=-1;this._lastHitTick=-999;
    this._hitSpec=hitSpec;
    this.snd.resume();
    if(id>=3000){
      this.snd.playSpecial(0.9);
      // Trigger hyper scene effect in the game (flash + slomo)
      if(typeof game!=='undefined'&&game&&game._hyperScene)game._hyperScene(this);
    }
    else if(id>=1000)this.snd.playSpecial(0.75);
    else             this.snd.playAtk(0.70);
    this.setAct(id);
    this._spendFor(id);
    if(id<1000)this._gainMeter(28);
    this.atkDmg=this._dmgMap.get(id)||Math.max(14,Math.round((meta?.score||4)*5));
    const activeStart=meta?.firstActive>=0?meta.firstActive:(frs.length>2?1:0);
    const activeEnd=meta?.lastActive>=0?meta.lastActive:Math.max(activeStart,frs.length-2);
    const tail=(meta?.lastActive??Math.max(1,frs.length-1))+2;
    this._activeStart=activeStart;this._activeEnd=activeEnd;
    this._cancelStart=Math.max(activeStart,Math.min(activeEnd,activeEnd-1));
    this._cancelEnd=Math.max(this._cancelStart,tail+1);
    this.atkTimeout=Math.max(12,Math.round(Math.max(Math.min(animDuration(frs)*1.12,tail+12),(hitSpec?.groundHittime||0)*0.45+(hitSpec?.airHittime||0)*0.20+activeEnd+2)));
    if(this.inAir)this.vx*=0.45;
    return true;
  }
  update(){
    this.stTick++;
    if(this.hitFlash>0)this.hitFlash--;
    if(this.justTaunted>0)this.justTaunted--;
    if(this.invFrames>0)this.invFrames--;
    if(this.guardCooldown>0)this.guardCooldown--;
    if(this.hitstunFrames>0)this.hitstunFrames--;
    if(this.hpRegenDelay>0)this.hpRegenDelay--;
    const calm=this.state==='STAND'||this.state==='WALK_F'||this.state==='WALK_B'||this.state==='RUN_F'||this.state==='RUN_B'||this.state==='CROUCH'||this.state==='GUARD';
    if(!this.inAir&&!this.isAtk&&this.state!=='KO'){
      this._gainMeter(calm?METER_REGEN_IDLE:METER_REGEN_ACTIVE);
      if(this.hpRegenDelay<=0&&calm&&this.hp>0&&this.hp<this.maxHp){
        this.hp=Math.min(this.maxHp,this.hp+HP_REGEN_PER_TICK);
      }
    }
    if(this.landingLag>0)this.landingLag--;

    // ── KO with aerial bounce ────────────────────────────────────
    if(this.state==='KO'){
      if(this.inAir){
        this.vy+=GRAVITY*1.05;this.x+=this.vx*0.7;this.y+=this.vy;
        this.vx*=0.86;
        if(this.y>=GROUND&&this.bounceCount<2){
          this.y=GROUND;this.bounceCount++;
          this.vy=-Math.max(2.5,Math.abs(this.vy)*0.38);
          this.vx*=0.50;
          if(this.snd)this.snd.playHit(0.25);
        }else if(this.y>=GROUND){
          this.y=GROUND;this.inAir=false;this.vy=0;this.vx*=0.35;
        }
      }else{
        this.vx*=0.74;
        this.x+=this.vx;
      }
      this.x=Math.max(65,Math.min(CW-65,this.x));
      this.koTimer--;if(this.koTimer<=0)this._respawn();
      return;
    }

    // ── Guard state ───────────────────────────────────────────────
    if(this.state==='GUARD'){
      if(--this.guardFrames<=0){this.isGuarding=false;this.setState('STAND',{stopNow:true});}
      return;
    }

    if(this.state==='ATTACK'){if(--this.atkTimeout<=0){this.isAtk=false;this.setState('STAND');}}
    if(this.state==='TAUNT'){if(--this.tauntTimer<=0){this.setState('STAND',{stopNow:true});}}

    // Crouch: AI controls duration; auto-exit after 55 ticks as safety valve
    if(this.state==='CROUCH'){
      if(++this._crouchTick>=55){this._crouchTick=0;this.setState('STAND');}
    }else{this._crouchTick=0;}

    // Advance animation
    const frs=this.frames(this.actId);
    if(frs?.length){
      const fr=frs[Math.min(this.fi,frs.length-1)];
      // BUG FIX #4: compensar velocidade da animação para walk/run.
      // adjDel = del * (3.4 / actualSpeed)  →  rápido = delay menor = animação mais rápida.
      // Range [0.38, 1.15]: walk lento toca ligeiramente mais devagar; corrida/turbo até 2.6x mais rápido.
      let del=fr.delay===-1?8:fr.delay<-1?99999:Math.max(1,fr.delay);
      const isWalkState=this.state==='WALK_F'||this.state==='WALK_B'||this.state==='RUN_F'||this.state==='RUN_B';
      if(isWalkState&&frs.length>1&&del<99999){
        const spd=Math.abs(this._moveSpeed||this._walkTarget||3.4);
        const speedFactor=Math.max(0.38,Math.min(1.15,3.4/spd));
        del=Math.max(1,Math.round(del*speedFactor));
      }
      if(++this.ft>=del){
        this.ft=0;this.fi++;
        if(this.fi>=frs.length){
          if(frs.loopStart!==undefined&&this.state!=='ATTACK'){
            // Loop only for non-attack states
            this.fi=frs.loopStart;
          }else{
            // BUG FIX (arrastar): walk/run sem loopStart ficavam presos no último frame
            // enquanto o personagem continuava se movendo → efeito de deslizar.
            // Solução: forçar reinício do frame 0 para qualquer estado de locomoção.
            if(this.state==='WALK_F'||this.state==='WALK_B'||this.state==='RUN_F'||this.state==='RUN_B'){
              this.fi=0;
            }else{
              // Non-looping or ATTACK — cap at last frame, let timeout/hitstun exit
              this.fi=frs.length-1;
              if(this.state==='ATTACK'){
                // Animation done: end attack immediately (timeout is a safety backup)
                this.isAtk=false;this.setState('STAND');
              }else if(this.state==='TAUNT'){
                this.setState('STAND',{stopNow:true});
              }else if(this.state==='HIT'&&this.hitstunFrames<=0){
                // Hitstun expired and animation done: slide to stand (preserve vx)
                this.setState('STAND',{keepVx:true,fromHit:true});
              }
              // else HIT but hitstun still active: hold last frame (handled above)
            }
          }
        }
      }
      const spr=this.char.sprites.get(`${fr.g},${fr.i}`);
      if(spr?.cvs){
        this._lastSpr=spr;this._lastFr=fr;
        const isIdle=this.state==='STAND'||this.state==='WALK_F'||this.state==='WALK_B'||
                     this.state==='CROUCH'||this.state==='GUARD'||this.state==='JUMP'||this.state==='RUN_F'||this.state==='RUN_B';
        if(isIdle){this._safeSpr=spr;this._safeFr=fr;}
      }
    }else{
      if(this.state==='ATTACK')this.setState('STAND');
    }

    // Physics
    if(this.inAir){
      this.vy+=GRAVITY;this.y+=this.vy;this.x+=this.vx;
      this.vx*=0.92;
      if(this.y<MIN_Y){this.y=MIN_Y;this.vy=Math.abs(this.vy)*0.1;}
      if(this.y>=GROUND){
        this.y=GROUND;this.inAir=false;this.vy=0;
        this.airHitCount=0;
        if(this.state==='JUMP'||this.state==='HIT_AIR'){
          if(this.state==='HIT_AIR')this.landingLag=12;
          // Apply landing momentum AFTER setState (don't let setState zero it)
          const landVx=this.vx*0.30;
          this.setState('STAND',{keepVx:true,fromLanding:true});
          this.vx=landVx; // restore landing slide after setState's vx halving
        }else if(this.state==='ATTACK'){
          const landVx=this.vx*0.15;
          this.landingLag=8;this.isAtk=false;
          this.setState('STAND',{keepVx:true,fromLanding:true});
          this.vx=landVx;
        }else{
          this.vx=0;this.setState('STAND',{stopNow:true});
        }
      }
    }else if(this.state==='WALK_F'){
      const walk=this._moveSpeed||this._walkTarget||Math.max(3.4,this.char.profile.bodyW*0.028);
      this.vx=this.facing*Math.abs(walk);
      this.x+=this.vx;
    }else if(this.state==='WALK_B'){
      const back=this._moveSpeed||this._walkTarget||-Math.max(2.8,this.char.profile.bodyW*0.022);
      this.vx=this.facing*Math.sign(back)*Math.abs(back);
      this.x+=this.vx;
    }else if(this.state==='RUN_F'){
      const run=this._moveSpeed||this._walkTarget||Math.max(6.2,this.char.profile.bodyW*0.040);
      this.vx=this.facing*Math.abs(run);
      this.x+=this.vx;
      if(this.runTimer>0&&--this.runTimer<=0)this.setState('WALK_F',{keepVx:true});
    }else if(this.state==='RUN_B'){
      const backrun=this._moveSpeed||this._walkTarget||-Math.max(5.0,this.char.profile.bodyW*0.032);
      this.vx=this.facing*Math.sign(backrun)*Math.abs(backrun);
      this.x+=this.vx;
      if(this.runTimer>0&&--this.runTimer<=0)this.setState('WALK_B',{keepVx:true});
    }else if(this.state==='HIT'){
      // Knockback decelerates; fighter can only move via vx decay
      this.vx*=0.68;
      this.x+=this.vx;
      // If hitstun expired and animation is on last frame → go to stand
      if(this.hitstunFrames<=0&&frs){
        const lastFi=frs.length-1;
        if(this.fi>=lastFi)this.setState('STAND',{keepVx:true});
      }
    }else if(this.state==='STAND'){
      if(this._standMomentumTicks>0){
        this._standMomentumTicks--;
        if(Math.abs(this.vx)>1.25&&this.char.moveMap.walkF.length&&this.state==='STAND'){
          this.setState(this.vx*this.facing>=0?'WALK_F':'WALK_B',{keepVx:true});
          this._walkTarget=(this.vx*this.facing>=0?1:-1)*Math.max(2.4,Math.min(4.8,Math.abs(this.vx)));
          this._moveSpeed=this._walkTarget;
        }else{
          this.x+=this.vx;
          this.vx*=0.72;
          if(Math.abs(this.vx)<0.2){this.vx=0;this._standMomentumTicks=0;}
        }
      }else{
        this.vx=0;
      }
    }else{
      this.vx=0;
    }
    this.x=Math.max(65,Math.min(CW-65,this.x));
    if(this.comboTimer>0&&--this.comboTimer<=0)this.comboCount=0;
  }
  _respawn(){
    this.hp=this.maxHp;this.comboCount=0;this.comboTimer=0;
    this.y=GROUND;this.vy=0;this.vx=0;this.inAir=false;
    this.hitstunFrames=0;this.landingLag=0;this.airHitCount=0;this._lastHitFi=-1;
    this.invFrames=65;
    this.setState('STAND',{stopNow:true});this._resetVisualCache();this.hitFlash=20;
  }
  // Hurtbox — wide enough to actually be hit
  // charW * 0.70 * scale gives a real body width matching the visual
  // Hurtbox — matches visual torso width (~55% of sprite charW)
  getHurt(){
    const frs=this.frames(this.actId),fr=frs?.[Math.min(this.fi,Math.max(0,(frs?.length||1)-1))];
    const sc=this.scale,p=this._prof;
    if(fr?.clsn2?.length){
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for(const b of fr.clsn2){
        const x1=Math.min(b.x1,b.x2),x2=Math.max(b.x1,b.x2);
        const y1=Math.min(b.y1,b.y2),y2=Math.max(b.y1,b.y2);
        minX=Math.min(minX,x1);minY=Math.min(minY,y1);maxX=Math.max(maxX,x2);maxY=Math.max(maxY,y2);
      }
      if(isFinite(minX)){
        const left=this.facing===1?this.x+minX*sc:this.x-maxX*sc;
        return{x:left,y:this.y+minY*sc,w:Math.max(10,(maxX-minX)*sc),h:Math.max(10,(maxY-minY)*sc)};
      }
    }
    const hw=Math.max(36, p.charW*0.55*sc);
    const hh=Math.max(80, p.bodyH);
    return{x:this.x-hw/2, y:this.y-hh, w:hw, h:hh};
  }
  getAtk(){
    if(!this.isAtk)return null;
    const frs=this.frames(this.actId);if(!frs?.length)return null;
    const meta=this.char.moveMap.meta?.[this.actId]||{};
    const spec=this._hitSpec||this._hitSpecFor(this.actId);
    const idx=Math.min(this.fi,frs.length-1),fr=frs[idx];
    const spr=this.char.sprites.get(`${fr?.g},${fr?.i}`);
    if(!spr?.cvs)return null;
    const activeStart=this._activeStart ?? (meta.firstActive>=0?meta.firstActive:(frs.some(f=>f?.clsn1?.length)?0:Math.max(1,Math.floor(frs.length*0.30))));
    const activeEnd=this._activeEnd ?? (meta.lastActive>=0?meta.lastActive:(frs.some(f=>f?.clsn1?.length)?frs.length-1:Math.max(activeStart,Math.ceil(frs.length*0.68)-1)));
    if(idx<activeStart||idx>activeEnd)return null;
    const sc=this.scale,p=this._prof;
    if(fr?.clsn1?.length){
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for(const b of fr.clsn1){
        const x1=Math.min(b.x1,b.x2),x2=Math.max(b.x1,b.x2);
        const y1=Math.min(b.y1,b.y2),y2=Math.max(b.y1,b.y2);
        minX=Math.min(minX,x1);minY=Math.min(minY,y1);maxX=Math.max(maxX,x2);maxY=Math.max(maxY,y2);
      }
      if(isFinite(minX)){
        const left=this.facing===1?this.x+minX*sc:this.x-maxX*sc;
        return {x:left,y:this.y+minY*sc,w:Math.max(8,(maxX-minX)*sc),h:Math.max(8,(maxY-minY)*sc),frame:idx,spec};
      }
    }
    if(meta.hasClsn1)return null;
    if(!spec)return null;
    const baseReach=Math.max(26,p.charW*0.44*sc);
    const isHyper=this.actId>=3000,isSpecial=this.actId>=1000;
    const reach=isHyper?baseReach*1.18:isSpecial?baseReach*1.04:baseReach*0.92;
    const hTop=p.bodyH*0.70,hBot=p.bodyH*0.18;
    const ex=this.facing===1?this.x+6:this.x-6-reach;
    return {x:ex,y:this.y-hTop,w:reach,h:hTop-hBot,frame:idx,spec};
  }
  hit(dmg,attackerFacing,hitSpec,attackerState){
    if(this.invFrames>0)return false;
    this.lastDmgReceived=dmg;
    this.hpRegenDelay=HP_REGEN_DELAY;
    const facingAttacker=(attackerFacing||1);
    const attackerInFront=((facingAttacker===1&&this.facing===-1)||(facingAttacker===-1&&this.facing===1));
    const canGuard=this.isGuarding&&this.state==='GUARD'&&this._canGuard(hitSpec)&&attackerInFront;
    if(canGuard){
      const chipBase=hitSpec?.guardDamage;
      const blocked=Math.max(0,Math.round(chipBase!==null&&chipBase!==undefined?chipBase:Math.max(1,dmg*0.08)));
      this.hp=Math.max(0,this.hp-blocked);
      this._gainMeter(10);
      this.hitFlash=3;
      const gv=hitSpec?.guardVelocity?.length?hitSpec.guardVelocity:[-Math.sign(facingAttacker)*1.05];
      this.vx=(gv[0]??(-Math.sign(facingAttacker)*1.05));
      this.guardFrames=Math.max(this.guardFrames||0,Math.max(8,((hitSpec?.pausetime?.[1]||0)+Math.round((hitSpec?.groundHittime||0)*0.38))));
      this.hitstunFrames=Math.max(this.hitstunFrames,Math.round(this.guardFrames*0.5));
      this.invFrames=Math.max(this.invFrames,2);
      this.snd.resume();this.snd.playHit(0.35);
      if(this.hp<=0){this.snd.playKO();this.guardFrames=0;this.isGuarding=false;this.setState('KO');return true;}
      return false;
    }
    this.hp=Math.max(0,this.hp-dmg);this._gainMeter(Math.min(38,10+dmg*0.12));this.hitFlash=8;this.invFrames=Math.max(this.invFrames,dmg>=70?6:4);
    const kbDir=attackerFacing||this.facing;
    const gv=hitSpec?.groundVelocity||[];
    const av=hitSpec?.airVelocity||[];
    this.vx=(this.inAir?(av[0]??(-kbDir*2.4)):(gv[0]??(-kbDir*(dmg>90?4.0:dmg>60?3.0:1.9))));
    this.snd.resume();
    if(this.hp<=0){
      this.snd.playKO();
      this.vy=this.inAir?(av[1]??-3.2):(dmg>=75?(av[1]??-2.8):-2.2);
      this.inAir=this.inAir||dmg>=75;
      this.setState('KO');
      return true;
    }
    this.snd.playHit();
    if(this.inAir){
      this.airHitCount=(this.airHitCount||0)+1;
      this.vy=av[1]??Math.min(this.vy,-4);
      this.hitstunFrames=Math.max(this.hitstunFrames,hitSpec?.airHittime||18);
      this.setState('HIT_AIR');
    }else if((hitSpec?.airVelocity?.length&&Math.abs(hitSpec.airVelocity[1]||0)>2.4)||dmg>105){
      this.inAir=true;
      this.vy=av[1]??-7.2;
      this.vx=av[0]??(-kbDir*3.0);
      this.airHitCount=1;
      this.hitstunFrames=Math.max(this.hitstunFrames,hitSpec?.airHittime||18);
      this.setState('HIT_AIR',{_vyPreset:true});
    }else{
      this.hitstunFrames=Math.max(this.hitstunFrames,hitSpec?.groundHittime||this.hitstunFrames||14);
      this.setState('HIT');
    }
    return true;
  }
  draw(ctx){
    const frs=this.frames(this.actId);
    let fr=frs?frs[Math.min(this.fi,frs.length-1)]:null;
    let spr=fr?this.char.sprites.get(`${fr.g},${fr.i}`):null;
    if(!spr?.cvs&&this.state==='ATTACK'&&frs?.length){
      let alt=null;
      for(let off=1;off<frs.length;off++){
        const a=frs[Math.max(0,Math.min(frs.length-1,(this.fi||0)-off))];
        const b=frs[Math.max(0,Math.min(frs.length-1,(this.fi||0)+off))];
        if(a&&this.char.sprites.get(`${a.g},${a.i}`)?.cvs){alt=a;break;}
        if(b&&this.char.sprites.get(`${b.g},${b.i}`)?.cvs){alt=b;break;}
      }
      if(alt){fr=alt;spr=this.char.sprites.get(`${alt.g},${alt.i}`);}
    }

    if(spr?.cvs){
      this._lastSpr=spr;
      // Only update safeSpr from idle states — attacks can have sprites with
      // large ax values that move the sprite off-screen near walls
      const isIdle=this.state==='STAND'||this.state==='WALK_F'||this.state==='WALK_B'||
                   this.state==='CROUCH'||this.state==='GUARD'||this.state==='JUMP';
      if(isIdle&&Math.abs(fr.ox||0)<120&&Math.abs(fr.oy||0)<120){
        this._safeSpr=spr;this._safeFr=fr;
      }
    }

    // Resolve draw sprite — current frame preferred; attacks only fall back to attack-nearby
    // or safe idle sprite, never to stale arbitrary sprites from older states/rounds.
    let drawSpr=spr?.cvs ? spr : (this._safeSpr||null);
    const useFallback=!spr?.cvs;
    let drawOx=useFallback?0:(fr?.ox||0);
    let drawOy=useFallback?0:(fr?.oy||0);
    let drawFlipHFinal=useFallback?false:(fr?.flipH||false);

    // Off-canvas guard — MUST compute position accounting for flip transform
    // ctx.transform(-1,0,0,1,this.x*2,0) maps drawX → 2*this.x - drawX
    // Only fall back when truly invisible (generous -120/+120 margin)
    if(spr?.cvs && drawSpr){
      const sc=this.scale;
      const rawDx=this.x - drawSpr.ax*sc + drawOx*sc;
      const rawDw=drawSpr.cvs.width*sc;
      const rawDy=this.y - drawSpr.ay*sc + drawOy*sc;
      const rawDh=drawSpr.cvs.height*sc;
      const flipped=(this.facing===-1)!==drawFlipHFinal;
      // Compute actual screen-space X extent after flip
      const scrLeft  = flipped ? (this.x*2 - (rawDx+rawDw)) : rawDx;
      const scrRight = flipped ? (this.x*2 - rawDx)          : (rawDx+rawDw);
      const scrTop   = rawDy;
      const scrBot   = rawDy+rawDh;
      const MARGIN=120; // generous: partial off-screen is fine, only hide when truly gone
      const offCanvas=scrRight<-MARGIN || scrLeft>CW+MARGIN || scrBot<-MARGIN || scrTop>CH+MARGIN;
      if(offCanvas && (this._safeSpr||this._lastSpr)){
        // Only swap to safe sprite — never erase completely
        drawSpr=this._safeSpr||this._lastSpr;
        // Use cached safe-frame offsets so sprite doesn't jump position on re-entry
        const _sfr=this._safeFr||this._lastFr;
        drawOx=_sfr?.ox||0; drawOy=_sfr?.oy||0; drawFlipHFinal=_sfr?.flipH||false;
      }
      // If nothing to fall back to, just draw the original (partial off-screen is fine)
    }

    // Ground shadow — always at floor level regardless of fighter y
    ctx.save();ctx.globalAlpha=0.22;ctx.fillStyle='#000';
    const shadowScale=this.inAir?Math.max(0.4,1-(this.y-GROUND>0?0:(GROUND-this.y)/200)):1;
    ctx.beginPath();ctx.ellipse(this.x,GROUND+5,34*shadowScale,6*shadowScale,0,0,Math.PI*2);ctx.fill();
    ctx.restore();

    if(drawSpr?.cvs){
      const sc=this.scale;
      const dx=this.x - drawSpr.ax*sc + drawOx*sc;
      const dy=this.y - drawSpr.ay*sc + drawOy*sc;
      const dw=drawSpr.cvs.width*sc, dh=drawSpr.cvs.height*sc;
      if(!isFinite(dx)||!isFinite(dy)||!isFinite(dw)||!isFinite(dh)||dw<=0||dh<=0)return;
      const fh=(this.facing===-1)!==drawFlipHFinal;

      // ── Sprite draw (hit flash filter isolated here) ──────────────
      ctx.save();
      if(this.hitFlash>0){
        // Cap brightness so it doesn't white-out the entire sprite
        const br=(1.3+Math.min(this.hitFlash,5)*0.14).toFixed(2);
        ctx.filter=`brightness(${br}) saturate(0) sepia(0.5)`;
      }
      if(fh)ctx.transform(-1,0,0,1,this.x*2,0);
      ctx.drawImage(drawSpr.cvs,dx,dy,dw,dh);
      ctx.restore(); // ← MUST restore here so filter doesn't bleed into guard overlay

      // ── Guard shield overlay (drawn clean, no filter) ─────────────
      if(this.isGuarding&&this.guardFrames>0){
        ctx.save();
        if(fh)ctx.transform(-1,0,0,1,this.x*2,0);
        ctx.globalAlpha=0.38*(this.guardFrames/22);
        ctx.fillStyle='#00aaff';
        ctx.fillRect(dx,dy,dw,dh);
        // Inner glow edge
        ctx.globalAlpha=0.22*(this.guardFrames/22);
        ctx.strokeStyle='#88ddff';ctx.lineWidth=2;
        ctx.strokeRect(dx,dy,dw,dh);
        ctx.restore();
      }
    }else{
      // Silhouette fallback — no sprites loaded at all
      ctx.save();
      if(this.hitFlash>0)ctx.filter='brightness(2.2) saturate(0)';
      ctx.fillStyle=this.facing===1?'#ff4010':'#0a9fff';
      const p=this._prof;
      ctx.beginPath();ctx.roundRect(this.x-p.bodyW/2,this.y-p.bodyH,p.bodyW,p.bodyH,4);ctx.fill();
      ctx.restore(); // restore filter before drawing name
      ctx.save();ctx.fillStyle='#fff9';ctx.font='6px monospace';ctx.textAlign='center';
      ctx.fillText(this.char.name.slice(0,8),this.x,this.y-p.bodyH-6);ctx.restore();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  AI — STRATEGIC COMPETITIVE FIGHTER  v10 (predição ordem-3 + Thompson)
//  v7: Zone enum · reactive layer · stratBias/heat · crouch · combo chains
//  v8 (uso inteligente de habilidades) — fundamentos competitivos:
//    1 · Anti-aéreo REATIVO — executa o golpe na reação ao pulo (_reactAntiAir),
//        usa super anti-aéreo quando vale a pena. Corrige "IA confusa com pulos".
//    2 · Whiff punish — converte recuperação do oponente em combo/super (_reactWhiffPunish)
//    3 · Economia de barra (_updateMeterPlan/_shouldCommitHyper) — nunca solta
//        super no vazio; guarda barra p/ reversal no canto/HP baixo; gasta em
//        combo confirmado, anti-aéreo, canto ou para fechar o round.
//    4 · Cadência adaptativa (_effInterval) — reage mais rápido sob ameaça/oportunidade
//    5 · Skill por lutador (reactionVar/confirmSkill) — rivais com "níveis" distintos,
//        persistidos entre rounds via memória.
// ═══════════════════════════════════════════════════════════════
