URL=${1:-localhost}

# create a self-signed certificate for local SSL purposes if one does not exist
if [ ! -f "ssl-cert.pem" ]
then
  # create private key
  openssl genrsa -out ssl-key.pem 2048
  # create certificate request for URL
  openssl req -new -nodes -key ssl-key.pem -subj "/C=  /ST= /L= /O=Dev/CN=$URL" -out ssl-csr.pem
  # self-sign certificate request
  openssl x509 -req -days 1000 -in ssl-csr.pem -signkey ssl-key.pem -out ssl-cert.pem
fi
