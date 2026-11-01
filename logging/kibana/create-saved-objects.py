"""Crea en Kibana las tres búsquedas guardadas y el dashboard del paso 10.

Uso: KB_PW=... python3 kibana_objects.py
Habla con Kibana por el ingress (Host: kibana.localhost) y usa la data view k8s-logs.
"""
import base64
import json
import os
import urllib.request

PW = os.environ['KB_PW']
AUTH = 'Basic ' + base64.b64encode(f'elastic:{PW}'.encode()).decode()
DV = {'type': 'index-pattern', 'id': 'k8s-logs'}


def call(method, path, body=None):
    req = urllib.request.Request('http://localhost' + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    for k, v in {'Host': 'kibana.localhost', 'kbn-xsrf': 'true', 'Content-Type': 'application/json',
                 'Authorization': AUTH}.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def put(type_, id_, attributes, references):
    return call('POST', f'/api/saved_objects/{type_}/{id_}?overwrite=true',
                {'attributes': attributes, 'references': references})


def search(id_, title, kql, columns):
    src = {'query': {'query': kql, 'language': 'kuery'}, 'filter': [],
           'indexRefName': 'kibanaSavedObjectMeta.searchSourceJSON.index'}
    put('search', id_, {'title': title, 'columns': columns, 'sort': [['@timestamp', 'desc']],
                        'kibanaSavedObjectMeta': {'searchSourceJSON': json.dumps(src)}},
        [dict(DV, name='kibanaSavedObjectMeta.searchSourceJSON.index')])


def lens(id_, title, vis_type, columns, order, visualization, kql=''):
    attrs = {'title': title, 'visualizationType': vis_type,
             'state': {'datasourceStates': {'formBased': {'layers': {'l1': {
                 'columns': columns, 'columnOrder': order, 'incompleteColumns': {}}}}},
                 'visualization': visualization,
                 'query': {'query': kql, 'language': 'kuery'}, 'filters': []}}
    put('lens', id_, attrs, [dict(DV, name='indexpattern-datasource-layer-l1')])


COUNT = {'label': 'Logs', 'dataType': 'number', 'operationType': 'count',
         'sourceField': '___records___', 'isBucketed': False, 'scale': 'ratio'}


def app_terms(size=10):
    return {'label': 'Servicio', 'dataType': 'string', 'operationType': 'terms', 'sourceField': 'app',
            'isBucketed': True, 'scale': 'ordinal',
            'params': {'size': size, 'orderBy': {'type': 'column', 'columnId': 'c_count'},
                       'orderDirection': 'desc'}}


# Búsquedas guardadas
search('errores-the-store', 'Errores de The Store', 'level : "ERROR"', ['app', 'message', 'kubernetes.pod_name'])
search('http-5xx', 'HTTP 5xx', 'status_code >= 500', ['app', 'method', 'path', 'status_code'])
search('ingress', 'Ingress', 'app : "ingress-nginx"', ['method', 'path', 'status_code'])

# Volumen por servicio: barras apiladas en el tiempo
lens('volumen-por-servicio', 'Volumen por servicio', 'lnsXY',
     {'c_time': {'label': '@timestamp', 'dataType': 'date', 'operationType': 'date_histogram',
                 'sourceField': '@timestamp', 'isBucketed': True, 'scale': 'interval',
                 'params': {'interval': 'auto'}},
      'c_app': app_terms(), 'c_count': COUNT},
     ['c_app', 'c_time', 'c_count'],
     {'legend': {'isVisible': True, 'position': 'right'}, 'preferredSeriesType': 'bar_stacked',
      'layers': [{'layerId': 'l1', 'layerType': 'data', 'seriesType': 'bar_stacked',
                  'xAccessor': 'c_time', 'accessors': ['c_count'], 'splitAccessor': 'c_app'}]})

# Errores por servicio: barras horizontales filtradas por nivel
lens('errores-por-servicio', 'Errores por servicio', 'lnsXY',
     {'c_app': app_terms(), 'c_count': COUNT}, ['c_app', 'c_count'],
     {'legend': {'isVisible': False, 'position': 'right'}, 'preferredSeriesType': 'bar_horizontal',
      'layers': [{'layerId': 'l1', 'layerType': 'data', 'seriesType': 'bar_horizontal',
                  'xAccessor': 'c_app', 'accessors': ['c_count']}]},
     kql='level : "ERROR"')


def code_filter(label, lo, hi):
    return {'label': label, 'input': {'query': f'status_code >= {lo} and status_code < {hi}', 'language': 'kuery'}}


# Códigos HTTP: dona con filtros 2xx, 4xx y 5xx
lens('codigos-http', 'Códigos HTTP', 'lnsPie',
     {'c_codes': {'label': 'Códigos HTTP', 'dataType': 'string', 'operationType': 'filters',
                  'isBucketed': True, 'scale': 'ordinal',
                  'params': {'filters': [code_filter('2xx', 200, 300), code_filter('4xx', 400, 500),
                                         code_filter('5xx', 500, 600)]}},
      'c_count': COUNT},
     ['c_codes', 'c_count'],
     {'shape': 'donut', 'layers': [{'layerId': 'l1', 'layerType': 'data', 'primaryGroups': ['c_codes'],
                                    'metrics': ['c_count'], 'numberDisplay': 'percent',
                                    'categoryDisplay': 'default', 'legendDisplay': 'default',
                                    'nestedLegend': False}]},
     kql='status_code : *')

# Dashboard
panels = [('p1', 'lens', 'volumen-por-servicio', 0, 0, 48, 14),
          ('p2', 'lens', 'errores-por-servicio', 0, 14, 24, 14),
          ('p3', 'lens', 'codigos-http', 24, 14, 24, 14),
          ('p4', 'search', 'errores-the-store', 0, 28, 48, 16)]
panels_json, refs = [], []
for pid, type_, oid, x, y, w, h in panels:
    panels_json.append({'type': type_, 'panelIndex': pid, 'panelRefName': f'panel_{pid}',
                        'gridData': {'x': x, 'y': y, 'w': w, 'h': h, 'i': pid},
                        'embeddableConfig': {'enhancements': {}}})
    refs.append({'name': f'{pid}:panel_{pid}', 'type': type_, 'id': oid})
put('dashboard', 'the-store-logs',
    {'title': 'The Store · Logs', 'panelsJSON': json.dumps(panels_json),
     'optionsJSON': json.dumps({'useMargins': True, 'syncColors': False, 'hidePanelTitles': False}),
     'timeRestore': True, 'timeFrom': 'now-30m', 'timeTo': 'now', 'refreshInterval': {'pause': False, 'value': 30000},
     'kibanaSavedObjectMeta': {'searchSourceJSON': json.dumps({'query': {'query': '', 'language': 'kuery'},
                                                               'filter': []})}},
    refs)
print('ok')
