# Pied Léger

Web app qui note la qualité de conduite d'un conducteur à partir des capteurs du téléphone (accéléromètre + GPS).

- Score de 0 à 100 sur 4 axes : freinage, virages, accélération, fluidité.
- Événements datés : freinage tardif (sans anticipation) ou brusque, accélération vive, virage serré, choc de chaussée (nid-de-poule, hors score), avec un conseil par trajet.
- Disque en temps réel dès le début de la session : le point suit la force ressentie (vers l'avant au freinage, vers l'arrière à l'accélération, sur le côté en virage).
- Jauge verticale à gauche du disque : secousses sous les roues gauches (G) et droites (D), pour repérer nid-de-poule à gauche/droite ou dos d'âne.
- Historique local (les mesures restent sur l'appareil).
- Sources : capteurs réels, démo simulée, import CSV (`t, ax, ay, az, speed`).

## Utilisation

Ouvrir la page en HTTPS sur un téléphone, choisir **Capteurs**. Mode **Grille verticale** (défaut) : téléphone en portrait sur la grille d'aération, écran vers soi, prêt dès le départ, le GPS affine l'orientation. Mode **Libre** : démarrer à l'arrêt puis accélérer doucement en ligne droite pour calibrer.

## Fichiers

- `index.html` : l'application (autonome, moteur inclus).
- `engine.js` : moteur d'analyse sans interface (même code que dans `index.html`).
- `test.js` : tests du moteur sur trajets simulés, `node test.js`.

## Limites

Pas de capture écran éteint (limite du web), seuils à caler sur de vrais trajets. Le côté gauche/droite des chocs est déduit du roulis ressenti : hypothèse à valider sur route.
