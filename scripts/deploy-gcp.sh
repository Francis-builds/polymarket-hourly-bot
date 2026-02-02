#!/bin/bash
# Deploy Polymarket Dip Bot to GCP
# Usage: ./scripts/deploy-gcp.sh

set -e

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-polymarket-bot}"
ZONE="us-east1-b"
INSTANCE_NAME="polymarket-bot"
MACHINE_TYPE="e2-small"

echo "🚀 Deploying Polymarket Dip Bot to GCP"
echo "   Project: $PROJECT_ID"
echo "   Zone: $ZONE"
echo "   Instance: $INSTANCE_NAME"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI not found. Install from: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if instance exists
if gcloud compute instances describe $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID &> /dev/null; then
    echo "✅ Instance $INSTANCE_NAME already exists"
    echo "   Connecting to update..."
else
    echo "📦 Creating new VM instance..."
    gcloud compute instances create $INSTANCE_NAME \
        --project=$PROJECT_ID \
        --zone=$ZONE \
        --machine-type=$MACHINE_TYPE \
        --image-family=ubuntu-2204-lts \
        --image-project=ubuntu-os-cloud \
        --boot-disk-size=20GB \
        --tags=polymarket-bot

    echo "⏳ Waiting for instance to be ready..."
    sleep 30
fi

# Create setup script to run on VM
SETUP_SCRIPT=$(cat <<'EOF'
#!/bin/bash
set -e

echo "🔧 Setting up Polymarket Bot..."

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "📦 Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    echo "Docker installed. You may need to re-login for docker group to take effect."
fi

# Install docker-compose plugin if not present
if ! docker compose version &> /dev/null; then
    echo "📦 Installing Docker Compose..."
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
fi

# Create project directory
mkdir -p ~/polymarket-bot
cd ~/polymarket-bot

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Upload your project files to ~/polymarket-bot"
echo "2. Copy .env.paper to .env (or create .env with real credentials)"
echo "3. Run: docker compose up -d"
echo "4. View logs: docker compose logs -f"
EOF
)

echo "📤 Running setup script on VM..."
gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID --command="$SETUP_SCRIPT"

echo ""
echo "✅ VM is ready!"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Copy project files to VM:"
echo "   gcloud compute scp --recurse --zone=$ZONE ./* $INSTANCE_NAME:~/polymarket-bot/"
echo ""
echo "2. SSH into the VM:"
echo "   gcloud compute ssh $INSTANCE_NAME --zone=$ZONE"
echo ""
echo "3. On the VM, start paper trading:"
echo "   cd ~/polymarket-bot"
echo "   cp .env.paper .env"
echo "   docker compose up -d"
echo "   docker compose logs -f"
echo ""
