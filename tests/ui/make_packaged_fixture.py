"""Create a synthetic painted model; never reads or rewrites personal models."""
import json
import zipfile
from pathlib import Path

folder = Path(__file__).resolve().parents[2] / 'build' / 'installed-app-qa'
folder.mkdir(parents=True, exist_ok=True)
vertices = [(0,0,0),(20,0,0),(20,20,0),(0,20,0),(0,0,20),(20,0,20),(20,20,20),(0,20,20)]
triangles = [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]
xml = '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>'
xml += ''.join('<vertex x="%s" y="%s" z="%s"/>' % v for v in vertices)
xml += '</vertices><triangles>'
xml += ''.join('<triangle v1="%s" v2="%s" v3="%s" paint_color="480CA"/>' % t for t in triangles)
xml += '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
with zipfile.ZipFile(folder / 'Painted cube ü & test.3mf', 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('3D/a.model', xml)
    archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/a.model"/></Relationships>')
    archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    archive.writestr('Metadata/project_settings.config', json.dumps({'filament_colour':['#676868','#00FF00','#FAFBFF']}))
    archive.writestr('Metadata/model_settings.config', '<config/>')
print(folder)
