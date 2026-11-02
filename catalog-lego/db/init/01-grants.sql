-- Execute automatiquement par l'image MariaDB a la PREMIERE creation de la base
-- (volume vide). Non rejoue aux demarrages suivants.
--
-- Permission large, dev uniquement : autorise `acervatim` a creer et supprimer la shadow
-- database dont `prisma migrate dev` a besoin. A NE PAS reprendre tel quel en prod, ou le
-- service n'a de droits que sur son propre schema (acv_cat_lego).

GRANT ALL PRIVILEGES ON *.* TO 'acervatim'@'%';
FLUSH PRIVILEGES;
