# Pied Léger

Web app qui note la qualité de conduite à partir des capteurs du téléphone (accéléromètre, gyroscope, GPS). Notation volontairement stricte. Deux écrans : **Conduite** (direct + dernier bilan) et **Historique**.

## Ce qui est mesuré

| Axe | Comportements | Repères |
|---|---|---|
| Freinage | freinage brusque (≥ 0,25 g), freinage tardif (sans lever le pied avant), dos d'âne pris > 30 km/h | télématique : brusque dès 0,3 g, normal < 0,2 g |
| Accélération | accélération vive (≥ 0,2 g) | conduite normale ≈ 1,5 m/s² |
| Virages | virage serré (≥ 0,25 g latéral) | |
| Volant | coup de volant (aller-retour latéral rapide), redressement brusque après dérive (inattention) | gyroscope, lacet |
| Fluidité | à-coups (jerk), passages de vitesse brusques (creux de couple puis reprise) | confort : jerk < 0,9 à 2,9 m/s³ |

Chaque axe mélange le nombre d'événements par km et l'effort réel (90ᵉ centile). Score final = 70 % moyenne pondérée + 30 % plus mauvais axe. Hors score : nids-de-poule et dos d'âne pris à vitesse normale (jauge verticale gauche/droite).

## Direct

Jauge verticale (roues gauches/droites, seuil de choc adaptatif au bruit de la route), disque des forces (le point suit la force ressentie, signal lissé 3 Hz : mouvements de la voiture, pas vibrations moteur), barre de volant, bandeau du dernier événement, puces de comptage par type, bouton **Recaler**.

## Utilisation

Ouvrir la page en HTTPS sur un téléphone, **Démarrer le trajet**. Téléphone dans n'importe quelle position : le calage est toujours automatique (accélérer doucement en ligne droite au départ ; le côté gauche/droite des chocs s'affine après un premier virage GPS).

## Alignement direct / historique

- Un seul signal lissé alimente l'affichage ET la détection.
- Un événement annoncé n'est jamais supprimé ; la liste finale est celle du direct (un virage dans un coup de volant est gardé, compté à moitié).
- Les puces du direct et du bilan sont calculées par la même fonction sur la même liste.
- Sauvegarde de secours toutes les 5 s : trajet récupéré si la page est tuée.
- Capteurs coupés (écran verrouillé) : bandeau en direct, avertissement dans le bilan.
- `node audit.js` : 36 sessions simulées, chaque événement du direct doit se retrouver à l'identique dans l'historique.

## Fichiers

- `index.html` : application autonome (moteur inclus).
- `engine.js` : moteur sans interface.
- `test.js`, `audit.js` : tests (`node test.js`, `node audit.js`).

## Limites

Seuils à caler sur de vrais trajets. Coups de volant, redressements, passages de vitesse et côté des chocs sont des heuristiques. Pas de capture écran éteint. L'historique repart à zéro à chaque changement de notation.
