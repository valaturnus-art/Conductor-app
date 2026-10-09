# Pied Léger

Web app qui note la conduite avec les capteurs du téléphone (accéléromètre, gyroscope, GPS) et la transforme en jeu entre amis. Notation volontairement stricte. Quatre onglets : **Conduire**, **Progrès**, **Amis**, **Trajets**.

## Ce qui est mesuré

| Axe | Comportements | Repères |
|---|---|---|
| Freinage | freinage brusque (≥ 0,25 g), freinage tardif, dos d'âne pris > 30 km/h | télématique : brusque dès 0,3 g |
| Accélération | accélération vive (≥ 0,2 g) | |
| Virages | virage serré (≥ 0,25 g latéral) | |
| Volant | coup de volant, redressement brusque après dérive (inattention) | gyroscope |
| Fluidité | à-coups (jerk), passages de vitesse brusques | confort : jerk < 0,9 à 2,9 m/s³ |
| Vitesse | excès > 5 s au-delà de la tolérance radar (5 km/h, 5 % au-delà de 100), sévère dès +20 | limitations OpenStreetMap |

En plus : **téléphone manipulé en roulant** (écran touché ou téléphone déplacé au-dessus de 15 km/h) = −8 points, 30 max. **Éco-dynamisme** : 95ᵉ centile de vitesse × accélération comparé à la limite de la norme européenne RDE (règlement UE 2017/1151), affiché à part.

Score = 70 % moyenne pondérée des axes + 30 % plus mauvais axe − pénalité téléphone. L'axe Vitesse ne compte que si la limitation est connue sur au moins 0,5 km et 30 % du trajet.

## En roulant

Cockpit (jauge verticale, disque des forces, barre de direction), panneau de limitation, bandeau du dernier événement, **coach vocal** (événements, excès, encouragements toutes les 10 min sans à-coup), **alerte pause** après 2 h de route sans arrêt de 10 min.

## Jeu

- **XP** gagnés par la qualité : rien sous 40, distance plafonnée à 20 km. Niveaux et titres.
- **20 badges** (Velours, Freins de soie, Flow, Dans les clous, Zéro écran, Nuit sereine…).
- **3 défis du jour** tirés au sort et **défi de la semaine** (score de la semaine passée + 3, 30 km et 3 trajets minimum).
- **Ligues hebdo** (Bronze < 60, Argent, Or, Platine, Diamant ≥ 90), score de la semaine pondéré par les km.
- **Série** : trajets consécutifs ≥ 70 (on récompense la qualité, pas le fait de rouler plus).
- **Coaching** : axe le plus faible des 5 derniers trajets, tendance, conseil.
- **Points noirs** : même défaut au même endroit (70 m) sur deux trajets. **Trajets habituels** : même départ et même arrivée (300 m), progression.
- **Carte du trajet** (tracé GPS, sans fond de carte) avec l'endroit de chaque événement.

## Amis, sans serveur

Tout passe par des liens (WhatsApp, SMS…) : **carte de profil** (image + lien), **défi** (score à battre sur une distance), **bravo**. Ouvrir le lien d'un ami l'ajoute au classement de la semaine et au fil d'activité. Le lien ne contient que pseudo, avatar, niveau et scores : jamais de trajet ni de position. Tout est revalidé à la réception.

## Fiabilité

- Un seul signal lissé pour l'affichage et la détection ; un événement annoncé n'est jamais supprimé.
- Sauvegarde de secours toutes les 5 s, trajet récupéré si la page est tuée.
- `node test.js` (moteur), `node audit.js` (36 sessions : direct = historique), `node game-test.js` (jeu et liens).

## Fichiers

- `index.html` : application autonome (moteur, jeu et interface inclus).
- `engine.js` : moteur sans interface. `game.js` : jeu et social sans interface.

## Limites

Seuils à caler sur de vrais trajets. Limitations OpenStreetMap parfois absentes ou fausses, et l'appariement à la route peut se tromper aux carrefours. Un passager qui touche l'écran est compté comme le conducteur. Les liens d'amis peuvent être modifiés à la main : le classement repose sur la confiance. L'historique reste dans le téléphone (60 trajets).
