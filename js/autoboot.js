// autoboot.js — VERSÃO AUTOMÁTICA (sem seleção na tela)
// · Procura na MESMA PASTA do site: .zip de personagens e imagem de fundo
//   (fundo.png / fundo.jpg / qualquer extensão de imagem)
// · Descoberta de arquivos: API do GitHub (github.io) → autoindex do servidor
//   → manifest.json → tentativa direta de nomes "fundo.*"
// · Sem imagem de fundo → fica o escuro padrão
// · Escolhe 2 zips aleatórios e inicia sozinho. Tecla N = nova dupla.

const AutoBoot={
  files:[],      // nomes de arquivos descobertos na pasta
  zips:[],       // só os .zip
  imgs:[],       // só as imagens
  _busy:false,

  _dirUrl(){
    // URL da pasta onde a página está
    const u=new URL(location.href);
    u.hash='';u.search='';
    u.pathname=u.pathname.replace(/[^/]*$/,'');
    return u;
  },

  async _listGitHub(){
    // user.github.io/repo/sub/ → GET /repos/user/repo/contents/sub
    const h=location.hostname;
    if(!/\.github\.io$/i.test(h))return null;
    const owner=h.split('.')[0];
    const parts=location.pathname.replace(/[^/]*$/,'').split('/').filter(Boolean);
    const repo=parts.shift()||`${owner}.github.io`;
    const path=parts.join('/');
    const api=`https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const r=await fetch(api,{headers:{Accept:'application/vnd.github+json'}});
    if(!r.ok)throw new Error('github api '+r.status);
    const j=await r.json();
    if(!Array.isArray(j))throw new Error('github api: não é diretório');
    return j.filter(e=>e.type==='file').map(e=>e.name);
  },

  async _listAutoindex(){
    // python -m http.server / nginx autoindex devolvem HTML com <a href>
    const r=await fetch(this._dirUrl().href,{headers:{Accept:'text/html'}});
    if(!r.ok)throw new Error('autoindex '+r.status);
    const html=await r.text();
    const names=[...html.matchAll(/href="([^"?#]+)"/gi)]
      .map(m=>decodeURIComponent(m[1]))
      .filter(n=>!n.endsWith('/')&&!/^https?:/i.test(n))
      .map(n=>n.split('/').pop());
    if(!names.length)throw new Error('autoindex vazio');
    return names;
  },

  async _listManifest(){
    const r=await fetch(new URL('manifest.json',this._dirUrl()).href);
    if(!r.ok)throw new Error('sem manifest');
    const j=await r.json();
    const arr=Array.isArray(j)?j:(j.files||[]);
    if(!arr.length)throw new Error('manifest vazio');
    return arr.map(String);
  },

  async _probeCommon(){
    // Último recurso: testa nomes comuns de fundo diretamente
    const names=[];
    const exts=['png','jpg','jpeg','webp','gif','bmp'];
    await Promise.all(exts.map(async ext=>{
      try{
        const r=await fetch(new URL('fundo.'+ext,this._dirUrl()).href,{method:'HEAD'});
        if(r.ok)names.push('fundo.'+ext);
      }catch(e){}
    }));
    return names;
  },

  async discover(status){
    const tries=[
      ['GitHub API',()=>this._listGitHub()],
      ['índice do servidor',()=>this._listAutoindex()],
      ['manifest.json',()=>this._listManifest()],
    ];
    for(const[label,fn]of tries){
      try{
        status('Listando arquivos via '+label+'...');
        const names=await fn();
        if(names&&names.length){this.files=names;return label;}
      }catch(e){/* tenta o próximo */}
    }
    status('Procurando fundo.* diretamente...');
    this.files=await this._probeCommon();
    return 'probe';
  },

  _classify(){
    const IMG=/\.(png|jpe?g|webp|gif|bmp)$/i;
    this.zips=this.files.filter(n=>/\.zip$/i.test(n));
    const allImgs=this.files.filter(n=>IMG.test(n));
    // Se existir algum "fundo*", usa só esses; senão, toda imagem da pasta vira cenário
    const fundo=allImgs.filter(n=>/^fundo/i.test(n));
    this.imgs=fundo.length?fundo:allImgs;
  },

  async _fetchFile(name){
    const r=await fetch(new URL(name,this._dirUrl()).href);
    if(!r.ok)throw new Error(name+' → HTTP '+r.status);
    const blob=await r.blob();
    // objeto compatível com File para loadZip/Stage.load
    return new File([blob],name,{type:blob.type||''});
  },

  _pickPair(){
    const pool=[...this.zips];
    for(let i=pool.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[pool[i],pool[j]]=[pool[j],pool[i]];}
    return pool.slice(0,2); // 1 zip só → espelho automático (chars[1]=clone)
  },

  async start(){
    if(this._busy)return;this._busy=true;
    const load=document.getElementById('loading');
    const status=m=>{setLoad(5,m);};
    document.getElementById('upload-screen').style.display='none';
    load.classList.add('show');
    try{
      const via=await this.discover(status);
      this._classify();
      _pushLog(`autoboot via ${via}: ${this.zips.length} zip(s), ${this.imgs.length} imagem(ns)`);

      // Fundo (opcional) — sem imagem fica o escuro padrão
      for(const name of this.imgs){
        try{
          status('Carregando cenário: '+name);
          const f=await this._fetchFile(name);
          const acc=Stage.imgs.length?[...Stage.imgs]:null;     // acumula múltiplos fundos
          const accU=Stage.urls.length?[...Stage.urls]:null;
          const n=await Stage.load(f);
          if(n&&acc){Stage.imgs=[...acc,...Stage.imgs];Stage.urls=[...accU,...Stage.urls];}
        }catch(e){_pushLog('fundo falhou: '+name);}
      }

      if(!this.zips.length){
        setLoad(0,'Nenhum .zip de personagem encontrado na pasta. '+
          'No GitHub Pages basta subir os zips junto; em outros servidores crie um manifest.json: ["kyo.zip","iori.zip","fundo.png"]');
        this._busy=false;return;
      }

      const pair=this._pickPair();
      status('Personagens: '+pair.join(' vs '));
      const f1=await this._fetchFile(pair[0]);
      await loadZip(1,f1);
      if(pair[1]){
        const f2=await this._fetchFile(pair[1]);
        await loadZip(2,f2);
      }
      if(!chars[0])throw new Error('falha ao carregar '+pair[0]);
      load.classList.remove('show');
      await startFight();
    }catch(e){
      setLoad(0,'Erro: '+e.message);
      console.error(e);
      this._busy=false;
    }
    this._busy=false;
  },

  // Tecla N: sorteia outra dupla
  async newPair(){
    if(!this.zips.length||this._busy)return;
    if(typeof game!=='undefined'&&game)game.stop?.();
    chars=[null,null];
    document.getElementById('fight-screen').classList.remove('show');
    const dz=document.getElementById('fight-btn');if(dz)dz.classList.remove('show');
    await this.start();
  }
};

window.addEventListener('DOMContentLoaded',()=>{AutoBoot.start();});
document.addEventListener('keydown',e=>{
  if(e.key==='n'||e.key==='N')AutoBoot.newPair();
});
