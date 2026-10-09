# Pied Léger

Web app qui note la qualité de conduite à partir des capteurs du téléphone (accéléromètre, gyroscope, GPS). Notation volontairement stricte.

## Ce qui est mesuré

| Axe | Comportements | Repères |
|---|---|---|
| Freinage | freinage brusque (≥ 0,25 g), freinage tardif (sans lever le pied avant), dos d'âne pris > 30 km/h | télématique : brusque dès 0,3 g, normal < 0,2 g |
| Accélération | accélération vive (≥ 0,2 g) | conduite normale ≈ 1,5 m/s² |
| Virages | virage serré (≥ 0,25 g latéral) | |
| Volant | coup de volant (aller-retour latéral rapide), redressement brusque après dérive (inattention) | gyroscope, lacet |
| Fluidité | à-coups (jerk), passages de vitesse brusques (creux de couple puis reprise) | confort : jerk < 0,9 à 2,9 m/s³ |

Chaque axe mélange le nombre d'événements par km et l'effort réel (90ᵉ centile). Score final = 70 % moyenne pondérée + 30 % plus mauvais axe. Hors score : nids-de-poule (jauge verticale gauche/droite).

## Direct

Jauge verticale (roues gauches/droites), disque des forces (le point suit la force ressentie), barre de volant, bandeau du dernier événement avec les points perdus, série « sans à-coup ».

## Utilisation

Ouvrir la page en HTTPS sur un téléphone, **Capteurs**. Mode **Grille verticale** (défaut) : portrait sur la grille d'aération, écran vers soi, prêt dès le départ. Mode **Libre** : accélérer doucement en ligne droite au départ. Sources : démo simulée, import CSV (`t, ax, ay, az, speed` + `heading`, `gx, gy, gz` en °/s facultatifs).

## Fichiers

- `index.html` : application autonome (moteur inclus).
- `engine.js` : moteur sans interface.
- `test.js` : tests, `node test.js`.

## Limites

Seuils à caler sur de vrais trajets. Coups de volant, redressements, passages de vitesse et côté des chocs sont des heuristiques (aucun accès au volant ni à la boîte). Pas de capture écran éteint. L'historique repart à zéro à chaque changement de notation.
