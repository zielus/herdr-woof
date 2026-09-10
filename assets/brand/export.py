"""Export the browser-reviewed Woof mark. Requires Pillow and CairoSVG."""
from pathlib import Path
from copy import deepcopy
import xml.etree.ElementTree as E
import cairosvg
from PIL import Image

HERE=Path(__file__).resolve().parent
RUN=HERE.parents[1]/'artifacts/draw-svg/woof-20260910'
NS='http://www.w3.org/2000/svg'
E.register_namespace('',NS)
def tag(s): return '{'+NS+'}'+s
master=E.parse(RUN/'final.svg').getroot().find(tag('g'))
bbox=Image.open(RUN/'renders/v001.png').getchannel('A').getbbox()
x0,y0,x1,y1=bbox
sizes=[16,24,32,48,64,128,180,256,512]
variants=[('woof','#c3c7f5',None),('woof-ink','#1c1c28',None),('tile-dark','#c3c7f5','#1c1c28'),('tile-light','#1c1c28','#f0f0fc')]
for name,fg,bg in variants:
    svg=E.Element(tag('svg'),{'viewBox':'0 0 1024 1024','role':'img','aria-label':'Woof barking dog logo'})
    E.SubElement(svg,tag('title')).text='Woof'
    if bg: E.SubElement(svg,tag('rect'),{'width':'1024','height':'1024','rx':'64','fill':bg})
    extent=780 if bg else 900
    scale=extent/max(x1-x0,y1-y0)
    tx=512-(x0+x1)*scale/2; ty=512-(y0+y1)*scale/2
    group=E.SubElement(svg,tag('g'),{'transform':f'translate({tx:.5f} {ty:.5f}) scale({scale:.7f})'})
    paths=deepcopy(master); paths.set('fill',fg); group.append(paths)
    blob=E.tostring(svg,encoding='unicode')
    (HERE/(name+'.svg')).write_text(blob+'\n')
    folder=HERE/'icons'/name; folder.mkdir(parents=True,exist_ok=True)
    for size in sizes:
        cairosvg.svg2png(bytestring=blob.encode(),write_to=str(folder/f'{size}.png'),output_width=size,output_height=size)
Image.open(HERE/'icons/tile-dark/256.png').save(HERE/'favicon.ico',sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
html='''<!doctype html><html lang="en"><meta charset="utf-8"><title>Woof logo assets</title><style>body{margin:40px;background:#e2e3ed;color:#1c1c28;font:16px system-ui}h1{font-size:24px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}article{padding:20px;background:white;border-radius:8px}article>img{width:100%;height:220px;object-fit:contain}.dark{background:#292936;color:#eee}.sizes{display:flex;align-items:center;gap:18px;padding:24px 0}small{display:block}h2{font-size:16px}</style><h1>Woof — accepted concept 10</h1><div class="grid">'''
for name,fg,bg in variants:
    html+=f'<article class="{"dark" if name=="woof" else ""}"><h2>{name}</h2><img src="{name}.svg" alt="{name}"></article>'
html+='</div>'
for name,fg,bg in variants:
    html+=f'<h2>{name}: actual pixel sizes</h2><div class="sizes {"dark" if name=="woof" else ""}">'
    for s in [16,24,32,48,64,128]:html+=f'<div><img src="icons/{name}/{s}.png" width="{s}" height="{s}" alt="{name} {s}px"><small>{s}px</small></div>'
    html+='</div>'
(HERE/'preview.html').write_text(html+'</html>')
# A standalone vector comparison sheet with the same production geometry.
sheet=E.Element(tag('svg'),{'viewBox':'0 0 1000 290'})
for i,(name,fg,bg) in enumerate(variants):
    E.SubElement(sheet,tag('rect'),{'x':str(i*250),'width':'250','height':'290','fill':'#292936' if name=='woof' else '#e2e3ed'})
    g=E.SubElement(sheet,tag('g'),{'transform':f'translate({i*250+15} 10) scale({220/1024})'})
    for child in E.parse(HERE/(name+'.svg')).getroot():g.append(deepcopy(child))
    E.SubElement(sheet,tag('text'),{'x':str(i*250+125),'y':'265','text-anchor':'middle','font-family':'sans-serif','font-size':'16','fill':'#ffffff' if name=='woof' else '#1c1c28'}).text=name
cairosvg.svg2png(bytestring=E.tostring(sheet),write_to=str(HERE/'preview.png'))
print('Exported 4 SVGs, 36 PNG icons, ICO, and previews. Source bounds:',bbox)
