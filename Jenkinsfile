pipeline {
    agent any

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Prepare Docker Project Env') {
            steps {
                sh 'cp /var/jenkins_home/env-files/visa-kpi-server.env "$WORKSPACE/visa-kpi-server.env"'
            }
        }

        stage('Build and Deploy') {
            steps {
                sh 'docker compose down'
                sh 'docker compose up --build -d'
            }
        }

    }
    post {
        always {
            sh 'rm -f "$WORKSPACE/visa-kpi-server.env"'
        }
    }
}