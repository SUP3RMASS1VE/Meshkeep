import os, sys, zipfile, shutil, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from helpers import make_3mf, make_stl, _rels, MODEL_REL, CTYPES_NO_PNG
import app
from http.server import ThreadingHTTPServer
temporary = tempfile.TemporaryDirectory(prefix='mme-ui-')
root=os.path.realpath(os.path.join(temporary.name, 'models')); os.makedirs(root, exist_ok=True)
vertices=[(0,0,0),(20,0,0),(20,20,0),(0,20,0),(0,0,20),(20,0,20),(20,20,20),(0,20,20)]
triangles=[(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]
def cube(path):
 with open(path,'w') as f:
  f.write('solid Cube\n')
  for tri in triangles:
   f.write('facet normal 0 0 0\nouter loop\n')
   for i in tri: f.write('vertex %s %s %s\n'%vertices[i])
   f.write('endloop\nendfacet\n')
  f.write('endsolid Cube\n')
cube(root+'/Workshop cube.stl'); shutil.copyfile(root+'/Workshop cube.stl',root+'/Cube copy.stl')
make_3mf(root+'/Designer project.3mf')
os.makedirs(root+'/Parts',exist_ok=True)
for i in range(83): make_stl(root+'/Parts/Bracket %03d.stl'%i)
ns='http://schemas.microsoft.com/3dmanufacturing/core/2015/02'
mesh='<mesh><vertices>'+''.join('<vertex x="%s" y="%s" z="%s"/>'%v for v in vertices)+'</vertices><triangles>'+''.join('<triangle v1="%s" v2="%s" v3="%s"/>'%t for t in triangles)+'</triangles></mesh>'
rootxml=f'''<model xmlns="{ns}" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" unit="millimeter"><resources><object id="1" type="model"><components><component objectid="1" p:path="/3D/Objects/parts.model"/><component objectid="2" p:path="/3D/Objects/parts.model" transform="1 0 0 0 1 0 0 0 1 30 0 0"/></components></object></resources><build><item objectid="1"/></build></model>'''
subxml=f'<model xmlns="{ns}" unit="millimeter"><resources><object id="1" name="Left cube" type="model">{mesh}</object><object id="2" name="Right cube" type="model">{mesh}</object></resources><build/></model>'
config='<config><object id="1"><metadata key="name" value="Assembly"/><part id="1"><metadata key="name" value="Left cube"/></part><part id="2"><metadata key="name" value="Right cube"/></part></object></config>'
with zipfile.ZipFile(root+'/Two-part assembly.3mf','w') as z:
 z.writestr('_rels/.rels',_rels([('/3D/3dmodel.model','model',MODEL_REL)]))
 z.writestr('[Content_Types].xml',CTYPES_NO_PNG)
 z.writestr('3D/3dmodel.model',rootxml)
 z.writestr('3D/Objects/parts.model',subxml)
 z.writestr('Metadata/model_settings.config',config)
with open(root+'/Display.obj','w') as f:
 for v in vertices: f.write('v %s %s %s\n'%v)
 for t in triangles: f.write('f %s %s %s\n'%tuple(i+1 for i in t))
with open(root+'/Display.ply','w') as f:
 f.write('ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 12\nproperty list uchar int vertex_indices\nend_header\n')
 for v in vertices: f.write('%s %s %s\n'%v)
 for t in triangles: f.write('3 %s %s %s\n'%t)
with open(root+'/Display.amf','w') as f:
 f.write('<amf unit="millimeter"><object id="1"><mesh><vertices>'+''.join('<vertex><coordinates><x>%s</x><y>%s</y><z>%s</z></coordinates></vertex>'%v for v in vertices)+'</vertices><volume>'+''.join('<triangle><v1>%s</v1><v2>%s</v2><v3>%s</v3></triangle>'%t for t in triangles)+'</volume></mesh></object></amf>')
api=app.Api(root,os.path.join(temporary.name,'catalogue.sqlite3'))
from watcher import FolderWatcher
watcher=FolderWatcher(api.library,root,interval=2)
watcher.start()
httpd=ThreadingHTTPServer(('127.0.0.1',18759),app.make_handler(api,'qa'))
print('QA_READY http://127.0.0.1:18759/?t=qa',flush=True)
try:
 httpd.serve_forever()
except KeyboardInterrupt:
 pass
finally:
 watcher.stop()
 httpd.server_close()
 temporary.cleanup()
